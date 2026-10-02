# Vendored: @noble/curves 1.9.7 + @noble/hashes 1.8.0 (MIT)

`noble-p256.js` is the part of these libraries the pairing protocol
(`../pair-protocol.js`, BACKLOG-3666) uses: P-256, SHA-256, HMAC, HKDF and the
byte helpers. It is a local, unminified bundle — no remote code. Licences:
`LICENSE-noble.txt`.

Built from the published npm tarballs (`npm pack @noble/curves@1.9.7
@noble/hashes@1.8.0`) with the entry `noble-p256.entry.mjs`:

    esbuild noble-p256.entry.mjs --bundle --format=iife --global-name=KeeprNoble \
      --target=es2020 --legal-comments=inline --outfile=noble-p256.js \
      --footer:js='if (typeof module !== "undefined" && module.exports) module.exports = KeeprNoble;'

The Keepr app loads these SAME files from the extension folder it ships, so
both sides run one implementation.
