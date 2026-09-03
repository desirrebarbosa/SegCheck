# Local correction database test

This isolated Postgres database exercises the corrected-mask migration and the
partial redo workflow. It does not use or modify the production Supabase
project.

Requirements:

- Docker Desktop running

Run from the repository root:

```sh
# Restore the latest local production dump and keep the database running
sh local-db/restore_dump.sh segcheck_dump.sql

# Or run the disposable correction fixture test
sh local-db/test.sh
```

The restored Postgres database is available at `localhost:55432` with database
`segcheck_test`, user `segcheck`, and password `segcheck`. The restore script
handles the PostgreSQL 17 dump on the PostgreSQL 16 local image and applies
the local native-enum version of the correction updates.

The test seeds one passed mask and two failed masks, submits one correction,
and verifies:

- corrected masks: 1
- remaining redo masks: 1
- total complete masks (`pass + fixed`): 2
- correction records: 1

`test.sh` removes its database volume when the fixture test exits. The restore
script does not remove the container, so it remains available for staging.
