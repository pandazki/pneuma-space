// The platform's services for this app: native storage, and the jobs in app/jobs/. server.mjs and the jobs import this file.
const broker = process.env.PNEUMA_SPACE_BROKER || 'http://pneuma-space.internal';

export async function native(command) {
  const response = await fetch(broker + '/broker', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(command)});
  const value = await response.json();
  if (!response.ok) throw Object.assign(Error(value.error?.message || 'Storage unavailable'), {status: response.status, code: value.error?.code});
  return value;
}

// Each trigger under capabilities.cron.triggers in pneuma-space.json is a job, run by app/jobs/<name>.mjs.
// The platform posts each delivery here, waking the app, and may post the same delivery again, so a finished one is recorded and skipped.
export const JOB_PATH = '/_pneuma-space/trigger/';

export async function runJob(req, res) {
  const id = String(req.headers['x-pneuma-space-delivery']);
  const attempt = Number(req.headers['x-pneuma-space-delivery-attempt']);
  const done = 'job:done:' + id;
  let name = '', status = 200;
  try {
    name = decodeURIComponent(req.url.slice(JOB_PATH.length).split('?')[0]);
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw Error('Not a job name.');
    let body = '';
    for await (const chunk of req) body += chunk;
    if (await native({type: 'kv.get', key: done})) console.log(`job ${name} skipped delivery ${id}: it already finished`);
    else {
      const job = (await import(`./jobs/${name}.mjs`)).default;
      await job({id, attempt, payload: JSON.parse(body || 'null')});
      await native({type: 'kv.put', key: done, value: Date.now(), ttl: 86400});
      console.log(`job ${name} finished delivery ${id} (attempt ${attempt})`);
    }
  } catch (error) {
    status = 500;
    console.error(`job ${name} failed delivery ${id} (attempt ${attempt}): ${error.message}`);
  }
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify({ok: status === 200}));
}
