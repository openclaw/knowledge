# Design reference archive

The UI and stores/sharing specs cite `Openclaw design system.zip`, a 2.6 MB
design-system prototype archive. It is not part of the plugin, is not packaged,
and is no longer kept in the working tree. Git history retains it.

Retrieve the latest committed version (commit `a77ae9f`, on `origin/main`):

```sh
git show 'a77ae9f:Openclaw design system.zip' > 'Openclaw design system.zip'
```

| Commit | SHA-256 | Notes |
|---|---|---|
| `a77ae9f` | `adac1073197d86252a82ee091b20603e1d110672ea93a804e29da3e081e37efa` | Latest committed version. Contains every path cited by [STORES_AND_SHARING_SPEC.md](STORES_AND_SHARING_SPEC.md), [UI_REDESIGN_SUPPORT.md](UI_REDESIGN_SUPPORT.md) and [DESIGN_HANDOFF.md](DESIGN_HANDOFF.md). |
| `978ca6a` | `1f91a30c48c4c68f43a944eeeb503a337d8e17ed582b53a091b41641781a9d30` | Earlier version. |

The stores/sharing spec records a reviewed SHA-256 of
`fc05abfc67704378c6784b5cd083fa26fe179ab6745d19b8a98fa8a4e015d2c2`. That
matches no committed version, so the reviewed copy was never committed. Use
`a77ae9f` and treat any differences from the reviewed copy as unverified.

Paths in the specs are relative to the archive root, for example
`ui_kits/control-ui/knowledge-v4.html`.
