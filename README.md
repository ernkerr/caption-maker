# Caption Maker worker

The Goose Tools **caption** worker. It runs on your own computer, polls
[goosetools.com](https://goosetools.com)'s caption queue, and writes captions in
your voice using your local **Claude Code** login — so there's nothing to pay us
for, and your drafting never leaves your machine.

It's the caption sibling of the [carousel worker](https://github.com/ernkerr/carousel-maker)
and shares the same connected-computer token: if you've already connected this
computer for carousels, captions work with the same token.

## Requirements

- Node.js ≥ 20
- [Claude Code](https://claude.com/claude-code) installed and signed in
  (`npm install -g @anthropic-ai/claude-code`, then run `claude` once to log in).

## Run it in the background (recommended)

Connect your computer at <https://goosetools.com/dashboard/caption> to get a
token, then:

```sh
npx --yes caption-maker-worker@latest install --token gt_your_token
```

That registers a login service so the worker runs whenever your computer is on.
Already connected for carousels? You can drop the `--token` — it reuses the saved one.

- Update:  `npx --yes caption-maker-worker@latest update`
- Status:  `npx --yes caption-maker-worker@latest status`
- Turn off: `npx --yes caption-maker-worker@latest uninstall`

## Run it in a terminal (dev / one-off)

```sh
node worker/index.js --url http://localhost:3000 --token gt_your_token
```

Config can also come from env vars (`GOOSETOOLS_URL`, `WORKER_TOKEN`), a
`worker/.env` file, or the shared `~/.goosetools/env` written by `install`.

## How it works

- **Caption jobs**: the server sends what the post is about, your voice guide,
  and the conversation so far. The worker prompts `claude -p` for one caption and
  reports the text back.
- **Voice jobs**: when you describe your voice on the website, the worker turns
  that description into a reusable `voice.md`-style guide.

`voice.md` in this repo is only a fallback used when a job arrives without a
saved voice; your real voice lives in your Goose Tools account.
