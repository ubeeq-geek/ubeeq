-- Existing principals retain their current scope and password authority.
ALTER TABLE ubeeq_accounts ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1));
ALTER TABLE ubeeq_accounts ADD COLUMN customer_password_state TEXT NOT NULL DEFAULT 'set' CHECK(customer_password_state IN ('unset','set'));
ALTER TABLE ubeeq_sessions ADD COLUMN account_scope_at_issue TEXT NOT NULL DEFAULT 'creator_operator' CHECK(account_scope_at_issue IN ('creator_operator','customer_account'));
