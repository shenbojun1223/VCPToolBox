# ServerProjectForge regression tests

Adapted from VCPChat 179712c366c7a7afc2c7df6a758938d14a42f44c. Only plugin import paths change, except the schema migration test uses a fixed injected Hub clock to avoid wall-clock lease expiry. All original assertions remain.

Run from VCPToolBox root: node --test --test-concurrency=1 tests/server-project-forge/*.test.js

These tests use synthetic temporary stores and loopback network fixtures, not production configuration. UI, preload and native-indexer-specific tests remain in VCPChat.
