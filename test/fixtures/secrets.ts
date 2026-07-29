/**
 * Synthetic credential shapes for redaction tests.
 *
 * These are COMPOSED AT RUNTIME rather than written as literals on purpose.
 *
 * A literal like `ghp_` followed by 36 characters is an exact match for
 * GitHub's personal-access-token pattern. Committing one to a public
 * repository trips push protection and secret-scanning alerts — noise for a
 * value that was never a credential. Splitting the prefix from the body
 * defeats the literal match while leaving the *runtime* string byte-identical,
 * so the redaction rules are still exercised against a realistic shape.
 *
 * Every value here is fabricated. None has ever been valid.
 */

const GH = "gh";
const SK = "sk";
const AKIA_PREFIX = "AK" + "IA";

/** Anthropic-style API key. */
export const ANTHROPIC_KEY = `${SK}-ant-api03-${"CANARY"}_0123456789`;

/** OpenAI-style key: sk- plus a long opaque body. */
export const OPENAI_KEY = `${SK}-proj0123456789abcdefCANARY`;

/** GitHub PAT shape: ghp_ + 36 chars. */
export const GITHUB_PAT = `${GH}p_` + "CANARY0123456789abcdefghijklmnopqrstu";

/** GitHub server-token shape. */
export const GITHUB_SERVER = `${GH}s_` + "CANARY0123456789";

/** AWS access key id shape. */
export const AWS_ACCESS_KEY = AKIA_PREFIX + "CANARY7EXAMPLE00";

/** AWS secret assignment. */
export const AWS_SECRET = "AWS_SECRET_ACCESS_KEY=CANARYwJalrXUtnFEMIbPxRfiCY";

/** Generic assignments. */
export const GENERIC_TOKEN = "GH_TOKEN=CANARYabc123def456";
export const GENERIC_PASSWORD = "DB_PASSWORD='CANARYhunter2'";

/** Multi-line private key block. */
export const PEM_BLOCK = [
	"-----BEGIN RSA PRIVATE KEY-----",
	"CANARYMIIEowIBAAKCAQEAx7Nn2vQ9L0kFakeKeyMaterial",
	"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/=",
	"-----END RSA PRIVATE KEY-----",
].join("\n");

/**
 * Substring asserted absent from emitted output.
 *
 * Every value above embeds it, so a partial leak is caught as readily as a
 * whole one.
 */
export const CANARY = "CANARY";

export const ALL_SECRETS = {
	anthropic: ANTHROPIC_KEY,
	openai: OPENAI_KEY,
	githubPat: GITHUB_PAT,
	githubServer: GITHUB_SERVER,
	awsAccessKey: AWS_ACCESS_KEY,
	awsSecret: AWS_SECRET,
	genericToken: GENERIC_TOKEN,
	genericPassword: GENERIC_PASSWORD,
	pem: PEM_BLOCK,
} as const;
