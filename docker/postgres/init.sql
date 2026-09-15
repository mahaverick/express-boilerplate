-- docker/postgres/init.sql
--
-- Runs once, automatically, when the postgres container's data directory is
-- empty (docker-entrypoint-initdb.d convention) — it never re-runs against
-- an existing volume. It provisions a second role/database dedicated to the
-- test suite, alongside the POSTGRES_USER/POSTGRES_DB dev database created
-- by the image itself, so dev data (boilerplate) and test data
-- (boilerplate_test) never share a database. .env.test already points at
-- test/test/boilerplate_test (committed ahead of this compose stack); this
-- is what actually creates that role and database.
--
-- CREATEDB: tests/helpers/worker-database.ts's global setup creates one
-- extra physical database per vitest worker (boilerplate_test_w1..N) so
-- concurrent forked workers never share test data. In CI, `services:`
-- creates its Postgres container's own POSTGRES_USER (`test`) as that
-- container's actual bootstrap superuser, so it already has this privilege
-- implicitly; CREATEDB here is what gives the local compose stack's
-- separate, non-superuser `test` role the same ability.
CREATE ROLE test LOGIN PASSWORD 'test' CREATEDB;
CREATE DATABASE boilerplate_test OWNER test;
