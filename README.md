# Saathi (साथी)

**Your life. Your people. Your way.**

Saathi is an accessibility-first prototype for discovering recurring small-group activities, learning everyday tasks at a chosen pace, and preparing a practical help request while keeping the user in control.

This repository contains a no-extra-dependency Node.js demo server and web app, plus a separate React Native app for Vega OS. It is a hackathon prototype, not a care service or production-ready community platform.

## What you can try

- Explore four recurring clubs with different participation options: Garden Circle, Slow Morning Chess, Old Film Songs & Stories, and Postcard Sketching.
- See clubs ranked by interests, caption preference, and participation style you chose, with a plain-language reason for a match. No club is hidden by personalization, and Saathi never auto-joins.
- Join or leave a club and see its upcoming sessions in the web experience and Vega app through one local demo backend.
- On the Vega TV app, open an optional one-step sample prompt for a club and choose a response with the remote. It is a local sample, not a live group call, and the response is not sent to anyone.
- In supported browsers, use **Speak** for one-shot chat input and voice confirmation while a help preview is open. On supported Vega devices, Alexa voice selection can activate named controls in the TV app; Alexa handles speech, and the TV app does not capture microphone audio.
- Ask Saathi about clubs or three curated learning guides. Conversation context is held in server memory for up to eight turns and 30 minutes of inactivity.
- On supported Vega devices, use Alexa voice selection to activate controls such as “Explore clubs,” “My gatherings,” or “Join Garden Circle.” Alexa handles the voice interaction; the Vega app does not capture microphone audio. The emulator can validate app navigation, but real Alexa voice selection requires a compatible device and remote.
- Change interests, caption preference, participation style, guide detail, and text size in **Privacy**. Joining records a participation choice. Preferences are shared with the web TV preview and Vega app while the server is running.
- Review a practical-help message before confirming a simulated request. No contact is actually sent.
- Inspect MCP JSON-RPC requests and responses in the web app's **Agent & MCP Trace** drawer.

The web app can use a configured model provider or a deterministic local tool planner. The Alexa+ experience in this prototype is a **web simulation**; there is no live Alexa+ invocation. The Vega app is a **Vega OS** app, not a Fire OS package. No Alexa-to-TV control or Amazon account linking is implemented.

## Run the web demo

Requires Node.js 20 or newer. The server and web app use only Node built-in modules; no `npm install` is needed for them.

```sh
node apps/server.mjs
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). Use the navigation to try Chat, Activities, Guidance, Privacy, Help, and the browser-based TV Companion preview.

The server binds to `127.0.0.1` by default. For the Vega Virtual Device, run it on the host interface:

```sh
HOST=0.0.0.0 node apps/server.mjs
```

The Vega app connects to the host at `10.0.2.2:4173`. Keep the server running while using either client. Activity membership, preferences, guide progress, simulated help status, and chat memory are in-memory demo state and reset when the server restarts.

## Optional model providers

Without credentials, Saathi uses its local structured planner. To use Bedrock Mantle Chat Completions, provide `AMAZON_API_KEY` (or `BEDROCK_API_KEY`) and optionally configure the region/model:

```sh
BEDROCK_REGION=us-east-1 \
BEDROCK_MANTLE_MODEL=mistral.mistral-large-3-675b-instruct \
HOST=0.0.0.0 node apps/server.mjs
```

Set the API key in your shell or secret manager before starting the server; never put it in source control. OpenAI and Gemini API keys are also recognized through `OPENAI_API_KEY` and `GEMINI_API_KEY`. The model provider receives the prompt and the context needed to answer. The app's tool and consent boundaries remain enforced by the server.

## Vega Virtual Device app

The TV app has its own React Native/Vega dependencies, separate from the dependency-free server. To build it, install the Vega CLI and SDK for your platform, then from `apps/SaathiTV`:

```sh
npm ci
vega project doctor
npm run build:release
vega virtual-device start
vega run-app build/aarch64-release/saathitv_aarch64.vpkg com.saathi.tv.main -d VirtualDevice
```

Start the server on `0.0.0.0` in a second terminal before launching the app. The Vega Virtual Device route to the host API has been confirmed. The app has remote-operable club filters, join/leave actions, a chat view, and vertically/horizontally scrollable content. Visual review of D-pad focus, native TV keyboard behavior, and accessibility on the device is still needed. A Vega build does not produce a Fire OS binary; test the target platform separately before making Fire TV compatibility claims.

## API overview

- `POST /api/agent/chat` — assistant response and tool trace.
- `GET /api/activities`, `POST /api/activities/{id}/join|leave` — club discovery and membership.
- `GET /api/sessions` — upcoming sessions in joined clubs.
- `GET|PATCH|DELETE /api/me/preferences` — read, save, or reset demo preferences.
- `GET /api/guidance`, `POST /api/guidance/progress` — curated task guidance.
- `GET /api/tv/state` — shared TV companion state.
- `POST /mcp` and `GET /mcp` — local MCP Streamable HTTP endpoint with eight tools.
- `/api/help/*` — preview, review, confirmation, and simulated request status.

The local MCP endpoint has no authentication and must not be exposed to the public internet. The demo uses one seeded user and volatile server memory; it is not designed for multiple users or production data.

## Checks

Run the dependency-free server suite with:

```sh
node --test apps/server.test.mjs
```

For the Vega app, `npm run lint` and `npm run build:release` run from `apps/SaathiTV`.

## Safety and limits

- Maya is a seeded demo contact. No person, emergency service, or external service receives a help request.
- Saathi does not monitor people, infer diagnoses, verify physical actions, or claim a task was completed.
- There is no medical guidance, family monitoring dashboard, or persistent account history.
- Preferences and chat memory are temporary demo state. Do not enter sensitive personal information.
- Seeded activities are examples, not verified real-world groups.

## License

MIT. See [LICENSE](LICENSE).
