ALTER TABLE captures ADD COLUMN facts TEXT;
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0005_page_facts.sql');
