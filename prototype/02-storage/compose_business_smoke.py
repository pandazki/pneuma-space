"""Real gateway and real database test for the same portable order service."""
import concurrent.futures
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import appctl

suffix = uuid.uuid4().hex[:10]
name, host = 'orders' + suffix, 'pgorder' + suffix
project, image = 'appbaseorder' + suffix, 'appbase-orders:' + suffix
volume = 'appbase-data-' + name
password = 'temporary-test-only'
base = 'http://127.0.0.1:8080/apps/' + name


def docker(*args, check=True):
    return subprocess.run(['docker', *args], cwd=str(ROOT), check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def request(method, path, value=None):
    data = json.dumps(value).encode() if value is not None else None
    req = urllib.request.Request(base + path, method=method, data=data, headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=35) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        return exc.code, json.load(exc)


def expect(status, result):
    code, body = result
    assert code == status, (status, code, body)
    return body


def publish(env=None):
    appctl.call('/apps/publish', {'name':name, 'image':image, 'env':env or {}})


def wait_postgres(compose):
    deadline = time.monotonic() + 45
    while docker(*compose, 'exec','-T','postgres','pg_isready','-U','postgres',check=False).returncode:
        if time.monotonic() > deadline:
            raise RuntimeError('temporary PostgreSQL not ready')
        time.sleep(.5)


def query(path, **values):
    return path + '?' + urllib.parse.urlencode(values)


def exercise(backend):
    sku, category = backend + '-book', "books'50%"
    stock = {'sku':sku,'category':category,'quantity':5,'price_cents':125}
    expect(201, request('POST','/stock',stock))
    assert expect(409, request('POST','/stock',stock))['created'] is False
    def purchase(i):
        return request('POST','/orders',{'order_id':backend+'-'+str(i),'sku':sku,'quantity':1})
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(purchase, range(12)))
    created = [body for code,body in responses if code == 201 and body['result'] == 'created']
    rejected = [body for code,body in responses if code == 409 and body['result'] == 'out_of_stock']
    assert (len(created),len(rejected)) == (5,7), responses
    assert expect(200,request('GET',query('/stock',sku=sku)))['quantity'] == 0
    orders = expect(200,request('GET',query('/orders',sku=sku,minimum=1)))
    assert len(orders) == 5
    assert expect(200,request('GET',query('/sales',category=category,minimum=5))) == [[category,5,625]]
    assert expect(200,request('GET',query('/sales',category=category,minimum=6))) == []
    repeated=expect(409,request('POST','/orders',{'order_id':orders[0][0],'sku':sku,'quantity':1}))
    assert repeated['result'] == 'duplicate'
    assert expect(200,request('POST','/cancel',{'order_id':orders[0][0]}))['result']=='cancelled'
    assert expect(404,request('POST','/cancel',{'order_id':orders[0][0]}))['result']=='not_found'
    assert expect(200,request('GET',query('/stock',sku=sku)))['quantity'] == 1
    assert expect(200,request('GET',query('/sales',category=category,minimum=4))) == [[category,4,500]]
    print(backend+': gateway, 12 concurrent orders, server-side filtering/aggregation, duplicate and cancellation passed',flush=True)
    return sku,category


with tempfile.TemporaryDirectory(prefix='appbase-orders-') as temp:
    temp_path=pathlib.Path(temp)
    config=temp_path/'compose.yaml'
    config.write_text('''services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: %s
    volumes:
      - data:/var/lib/postgresql/data
    networks:
      apps:
        aliases: [%s]
networks:
  apps:
    external: true
    name: appbase-local
volumes:
  data:
'''%(password,host))
    # Build context contains only the five source files and Dockerfile needed.
    context=temp_path/'context'
    files=('templates/counter/store.py','templates/counter/relational.py','prototype/02-storage/order_service.py','prototype/02-storage/order_http.py','prototype/02-storage/Dockerfile')
    for item in files:
        dest=context/item
        dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(ROOT/item,dest)
    compose=['compose','-p',project,'-f',str(config)]
    built=published=False
    try:
        assert all(row['name']!=name for row in appctl.call('/apps'))
        assert docker('volume','inspect',volume,check=False).returncode!=0
        assert docker('image','inspect','python:3.12.12-slim',check=False).returncode==0
        assert docker('image','inspect','postgres:16-alpine',check=False).returncode==0
        docker('build','-f',str(context/'prototype/02-storage/Dockerfile'),'-t',image,str(context));built=True
        docker(*compose,'up','-d');wait_postgres(compose)
        publish();published=True
        docker('run','--rm','--network','none','-e','PGPASS_LINE='+host+':5432:postgres:postgres:'+password,
               '-v',volume+':/data','--entrypoint','sh','python:3.12.12-slim','-c','umask 077; printf "%s\\n" "$PGPASS_LINE" > /data/.pgpass')
        sqlite_sku,category=exercise('sqlite')
        pg={'DB_BACKEND':'postgres','PGHOST':host,'PGPORT':'5432','PGDATABASE':'postgres','PGUSER':'postgres'}
        publish(pg)
        assert expect(200,request('GET',query('/stock',sku=sqlite_sku)))['quantity'] is None
        postgres_sku,_=exercise('postgres')
        docker(*compose,'restart','postgres');wait_postgres(compose)
        assert expect(200,request('GET',query('/stock',sku=postgres_sku)))['quantity']==1
        container=docker('ps','--filter','label=appbase.name='+name,'--format','{{.Names}}').stdout.strip()
        assert container and '\n' not in container
        docker('restart',container)
        assert expect(200,request('GET',query('/sales',category=category,minimum=4)))==[[category,4,500]]
        publish()
        assert expect(200,request('GET',query('/stock',sku=sqlite_sku)))['quantity']==1
        assert expect(200,request('GET',query('/stock',sku=postgres_sku)))['quantity'] is None
        publish(pg)
        assert expect(200,request('GET',query('/stock',sku=postgres_sku)))['quantity']==1
        print('PASS: same order API, SQLite/PostgreSQL, independent persistent data and database/app restart',flush=True)
    finally:
        errors=[]
        if published:
            try:appctl.call('/apps/remove',{'name':name})
            except Exception as e:errors.append('remove app: '+str(e))
        result=docker(*compose,'down','-v','--remove-orphans',check=False)
        if result.returncode:errors.append('remove postgres: '+result.stderr)
        if published:
            result=docker('volume','rm',volume,check=False)
            if result.returncode and 'No such volume' not in result.stderr:errors.append('remove volume: '+result.stderr)
        if built:
            result=docker('image','rm',image,check=False)
            if result.returncode:errors.append('remove image: '+result.stderr)
        if errors:raise RuntimeError('; '.join(errors))
