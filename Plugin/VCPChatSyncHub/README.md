# VCPChatSyncHub

VCPChatSyncHub turns VCPToolBox into a central data plane shared by multiple
VCPChat desktop clients and VCPMobile. It supports released VCPMobile 1.1.3 on
legacy Wire 1.1 and protocol-aware clients on strict Wire 1.2 while keeping one
AppData-compatible entity layout for agents, groups, topics, messages, avatars,
attachments and deletion tombstones.

## Configure

Copy `config.env.example` to `config.env`, set a strong `MobileSyncToken`, and
restart VCPToolBox. The hub refuses to start when the token is empty or still
uses the example placeholder.

Defaults:

- HTTP: `http(s)://<toolbox-host>:<toolbox-port>/api/mobile-sync`
- WebSocket: `ws(s)://<toolbox-host>:5975/ws-sync`
- Data: `Plugin/VCPChatSyncHub/data/AppData`

The HTTP and WebSocket transports use the same token. HTTP accepts
`x-sync-token`, `Authorization: Bearer <token>`, or `?token=...`; WebSocket uses
`?token=...`.

For an Internet-facing deployment, terminate TLS in the existing reverse proxy
and forward both the HTTP path and WebSocket endpoint. Do not expose port 5975
without TLS on an untrusted network.

## VCPMobile

Use the VCPToolBox public base URL as the mobile HTTP service URL and the public
WebSocket URL as the mobile WebSocket service URL. The first WebSocket business
frame must be `VERSION_CHECK`. A missing `protocolVersion`, as emitted by the
released VCPMobile 1.1.3 APK, negotiates legacy Wire 1.1 and receives
`version: "1.0.0"`, `pluginVersion: "1.1.0"`, and `protocolVersion: "1.1"`.
An explicit `protocolVersion: "1.2"` receives the strict 1.2 contract and
plugin version 1.2.0. Other versions fail closed.

Compatibility is scoped to the negotiated connection. Wire 1.1 accepts the
known 1.1.3 omissions: topic `ownerId`, the Phase 2.5 compound `topics` array,
Phase 3 message owner identity, transient empty topic hashes, and missing
`deletedAt` on authenticated delete frames. Wire 1.2 keeps all of those fields
strict. HTTP message pull/push cannot carry WebSocket connection state, so an
omitted owner is resolved from the authoritative topic index; partial,
invalid, or conflicting explicit identities are always rejected. Legacy
per-topic stream errors remain strings while Wire 1.2 uses structured errors.

The hub also retains three authenticated desktop-only HTTP endpoints under
`/api/mobile-sync/desktop/*` for complete Agent and Group configuration sync.

## Storage and backup

The central store is deliberately ignored by Git. Back up the configured
AppData directory together with the adjacent `sync_state.db`; source-control
sync is not a database backup strategy.
