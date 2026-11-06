# notes-py

A notes app in Python with no SDK: `app.py` reads the contract's variables and headers itself. Each signed-in subject keeps its own notes in `db`, SQLite or PostgreSQL behind the same SQL; the nightly `export` trigger writes `notes.csv` to `/data` and leaves the file untouched on a redelivery; every link and form starts with `X-Forwarded-Prefix`; `SIGTERM` closes the server.

```sh
python3 -m unittest test_app                                        # the export and prefix tests, standard library only
docker build -t notes-py . && docker run --rm -p 127.0.0.1:8000:8000 -e PNEUMA_SPACE_APP=dev -e PNEUMA_SPACE_RELEASE=0 \
  -e PNEUMA_SPACE_FILES_DIR=/data -e PNEUMA_SPACE_DB_URL=sqlite:///data/app.sqlite3 notes-py   # then curl with the headers from templates/app/AGENTS.md
node ../publish.ts notes-py --owner user:<you>                       # docker build and publish; `appctl policy notes-py db_backend=postgres` switches engine
```
