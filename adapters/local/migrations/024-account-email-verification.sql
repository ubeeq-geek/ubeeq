-- Schema only: never infer ownership or mark an existing email verified.
CREATE TABLE ubeeq_account_email_challenges (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES ubeeq_accounts(id),
 session_id TEXT NOT NULL REFERENCES ubeeq_sessions(id), email TEXT NOT NULL,
 account_fingerprint TEXT NOT NULL, code_hash TEXT NOT NULL, created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 state TEXT NOT NULL CHECK(state IN ('active','superseded','consumed','exhausted')),
 delivery_state TEXT NOT NULL CHECK(delivery_state IN ('pending','dispatching','sent','unknown','cancelled')),
 delivery_observed_at TEXT, consumed_at TEXT
);
CREATE INDEX ubeeq_account_email_challenges_account_time ON ubeeq_account_email_challenges(account_id,created_at);
