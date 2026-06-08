-- MariaDB init script for the consumer-environment compose stack.
-- Runs once on first container start (mariadb image picks up *.sql
-- files from /docker-entrypoint-initdb.d in lexicographic order).
--
-- Creates the two databases + matching per-consumer users so each
-- backend can connect with its own credentials without the CI
-- workflow having to script extra DDL.

CREATE DATABASE IF NOT EXISTS mempool CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS cat21   CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'mempool'@'%' IDENTIFIED BY 'mempool';
GRANT ALL PRIVILEGES ON mempool.* TO 'mempool'@'%';

CREATE USER IF NOT EXISTS 'cat21'@'%' IDENTIFIED BY 'cat21';
GRANT ALL PRIVILEGES ON cat21.*   TO 'cat21'@'%';

FLUSH PRIVILEGES;
