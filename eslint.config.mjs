import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// The non-custodial posture rests on one property: the server cannot produce a
// user's signature, because it holds no key that could. That is true today
// because ephemeral keys are generated in the browser and never transmitted.
//
// It is also a property a single well-meaning import can undo, silently, in a
// file nobody re-reads. This rule is the guard: server code may not import the
// primitives needed to reconstruct a keypair or sign as a user.
//
// Deliberately an error, not a convention. A convention documents the intent;
// this fails the build.
const SERVER_SIGNING_BAN = {
  files: ["src/pages/api/**/*.ts", "src/pages/api/**/*.tsx"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "@mysten/sui/keypairs/ed25519",
            message:
              "Server code must not construct keypairs. Ephemeral keys are generated in the browser and never reach the server (src/lib/zklogin-ephemeral-key.ts). Build the transaction client-side and sign it with src/lib/zklogin-client-signer.ts. For sponsored gas the server adds only the SPONSOR signature via /api/sponsor/*, never the user's.",
          },
          {
            name: "@mysten/sui/cryptography",
            importNames: ["decodeSuiPrivateKey"],
            message:
              "Server code must not decode private keys. This is how the pre-2026-08 server reconstructed a user's ephemeral key to sign on their behalf, which made the sponsored and self-paid paths equally custodial.",
          },
          {
            name: "@mysten/sui/zklogin",
            importNames: ["getZkLoginSignature"],
            message:
              "Assembling a zkLogin signature server-side means signing as the user. Minting the salt and zkProof is a legitimate server role; producing the signature is not.",
          },
        ],
      },
    ],
  },
};

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  SERVER_SIGNING_BAN,
];

export default eslintConfig;
