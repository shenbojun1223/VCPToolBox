# VCPChatSyncHub

VCPChatSyncHub turns VCPToolBox into a central data plane shared by multiple
VCPChat desktop clients and VCPMobile. It keeps the upstream Mobile Sync V2
transport on wire protocol 1.1 and the AppData-compatible entity layout, including agents, groups,
topics, messages, avatars, attachments and deletion tombstones.

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
WebSocket URL as the mobile WebSocket service URL. The protocol is inherited
from upstream VCPMobileSync 1.1. The first WebSocket business frame must be a
`VERSION_CHECK`. Official VCPMobile 1.1.x clients may omit `protocolVersion`;
desktop clients send `protocolVersion: "1.1"`, and an explicitly incompatible
version still fails closed. `VERSION_ACK` exposes both the mobile-compatible
legacy `version: "1.0.0"` identifier and the actual desktop
`pluginVersion: "1.1.0"`/`protocolVersion: "1.1"` fields. These values are
deliberately independent: changing the hub package version must not break the
mobile client's legacy package-version gate.

The hub also retains three authenticated desktop-only HTTP endpoints under
`/api/mobile-sync/desktop/*` for complete Agent and Group configuration sync.

## Storage and backup

The central store is deliberately ignored by Git. Back up the configured
AppData directory together with the adjacent `sync_state.db`; source-control
sync is not a database backup strategy.
