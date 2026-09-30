ALTER TABLE "oauth_transactions" DROP COLUMN "code_verifier_nonce";--> statement-breakpoint
ALTER TABLE "oauth_transactions" DROP COLUMN "code_verifier_ciphertext";--> statement-breakpoint
ALTER TABLE "oauth_transactions" DROP COLUMN "key_version";