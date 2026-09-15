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
CREATE ROLE test LOGIN PASSWORD 'test';
CREATE DATABASE boilerplate_test OWNER test;
