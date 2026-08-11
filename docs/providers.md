# Providers

The two API backends, including zero-data-retention routing. See the [README](../README.md#documentation) for the full docs index.

Communicator supports two API backends:

- **OpenRouter** — Multi-provider gateway with endpoint-level routing. When you select a model, you'll pick which provider (e.g., OpenAI, Azure, Anthropic) actually serves the request. Supports cache-hit detection and per-endpoint pricing comparisons. Use `--provider openrouter` (this is the default).

- **Venice.ai** — Direct model access without multi-provider routing. Models are available directly; there's no endpoint picker step. Venice's `/models` endpoint is public, so you can list models without an API key. Use `--provider venice`.

The provider is saved in each session, so resuming a Venice session automatically uses the Venice backend — no need to pass `-p venice` again.

## Zero data retention (ZDR)

OpenRouter lets you force **zero data retention** per request: no caching, no logging, no training on your prompts or responses. Pass `--zdr` (OpenRouter only — silently ignored on Venice) and every request in the session carries `provider.zdr: true`.

Selection is **filtered to ZDR-capable entries**: the model picker shows only models with a zero-retention endpoint, the provider picker shows only `[zero retention]` endpoints, and a non-interactive `-m <model>` fails at selection — before any request — if the model has no ZDR endpoints. The runtime error is kept as a safety net for paths that bypass selection (`--resume`, mid-chat model switches, index drift). Without `--zdr` nothing changes — normal (non-ZDR) routing applies.

Privacy metadata comes from OpenRouter's own public endpoints and is fetched live (cached briefly, non-fatal on failure):

- **`[zero retention]` tag** — the provider picker marks endpoints listed in OpenRouter's ZDR index; `--list-endpoints` shows a `zdr yes/no` column; `--list-models` marks models that have at least one ZDR-capable endpoint as `[zdr]`
- **Privacy policy links** — each provider row in `--list-endpoints` prints its `privacy policy` URL, and the picker's description line shows a clickable `privacy policy` OSC 8 hyperlink (plain text in terminals without hyperlink support)

Caveats: `--zdr` is a per-invocation flag, not persisted. ZDR-capable providers may not support web search — combining `--zdr` with `--web-search` is allowed, but the request can be rejected by the API depending on the provider. If OpenRouter's ZDR index can't be fetched, `--zdr` prints a warning and skips filtering, relying on the runtime error instead. `--resume` keeps the session's model/effort/temperature but ZDR must be re-passed with `--zdr` on the resuming invocation.

## End-to-end encryption (E2EE)

Venice runs a subset of its models inside hardware-secured enclaves (TEE) and offers **end-to-end encryption**: prompts are encrypted **client-side** before leaving your machine and only the attested enclave can decrypt them — Venice's own infrastructure cannot read the conversation.

### Usage

```bash
communicator --provider venice --e2ee
communicator --provider venice --e2ee -m "e2ee-qwen3-5-122b-a10b" "What is 2+2?"
```

`--e2ee` requires `--provider venice` and filters model selection to E2EE-capable models (those advertising `capabilities.supportsE2EE`). The model picker, `-m`, and the `/model` command all refuse non-E2EE models, so a session never leaves encrypted mode. The session banner shows an `[e2ee]` badge.

### How it works

- Per session, Communicator generates an ephemeral secp256k1 key pair and fetches the model's **TEE attestation** (`/tee/attestation`), checking the reported `verified` flag, the nonce echo and the enclave signing key before trusting it. Any verification failure aborts the session — there is no fallback to plaintext.
- `user` and `system` messages are encrypted per message with ECDH → HKDF-SHA256 → AES-256-GCM and sent with the `X-Venice-TEE-*` headers; streamed responses arrive as encrypted chunks that are decrypted locally in real time.
- Encryption is streaming-only (which is what this client always uses), and the Venice system prompt is disabled so nothing leaks outside your ciphertext.
- **Trust model**: the attestation is a JSON assertion reported by the Venice API — the client checks its fields but performs no cryptographic quote/signature verification. E2EE therefore keeps prompts secret from *passive* infrastructure (the host processes ciphertext), but a compromised Venice backend could attest dishonestly and see your prompts. The guarantee is TLS plus a server-side secrecy claim, not an independently verifiable enclave proof. Streamed responses also **fail closed**: if the host ever sends an unencrypted chunk in an E2EE session, the stream is aborted rather than silently downgraded.

### Constraints

E2EE intentionally disables features that would leak content or that the enclave cannot serve:

- **Web search** — rejected at the CLI (`--web-search`, `--web-results`) and in the REPL (`/web-search`, `/web-results` are hidden and refused); web search is forced off even if a per-model preference says otherwise.
- **Attachments** — `--attach` is rejected; `/attach` and `/attachments` are hidden and refused.
- **Prompt caching** — `prompt_cache_key` is not sent; the host cannot key a cache on ciphertext.
- **Image generation** — `--image` is rejected; E2EE is text-only.
- **Resume** — sessions record an `e2ee` marker. An encrypted session may only be resumed with `--e2ee`, and `--e2ee` refuses to resume an unencrypted session — both directions fail fast rather than silently downgrade.

If you need web search or file uploads, run the same model without `--e2ee` (it will still run inside the TEE, though prompts stay readable to the host).
