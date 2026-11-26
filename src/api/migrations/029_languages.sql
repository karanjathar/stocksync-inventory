-- Release 5 (T112): a chat customer's language (detected from the first message, changeable by the customer).
ALTER TABLE customers ADD COLUMN language text CHECK (language IN ('en', 'hi'));
-- A signed-in user's interface language.
ALTER TABLE users ADD COLUMN language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'hi'));
