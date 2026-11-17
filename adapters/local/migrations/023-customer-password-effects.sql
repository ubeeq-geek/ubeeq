CREATE TABLE ubeeq_customer_password_effects (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES ubeeq_accounts(id),
 kind TEXT NOT NULL CHECK(kind IN ('initial','change')),
 applied_at TEXT NOT NULL,
 payload TEXT NOT NULL
);
