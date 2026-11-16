# Vendored code

## Mermaid

- File: `mermaid.min.js`, copied unchanged from `dist/mermaid.min.js` of the npm package.
- Package: `mermaid@11.17.2`, from the npm registry (`npm pack mermaid@11.17.2`).
- Tarball integrity (`dist.integrity` from the registry): `sha512-V6K3C8EBdEsPFZXSKMJe6ppQOENxuHARr9GvHX4hh47lAbhMRD9qf4oEK7LoaRQxULMa80/qt5gHO73aCleBBg==`
- sha256 of `mermaid.min.js`: `581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8`
- Size: 3,572,661 bytes.
- Licence: MIT, in `mermaid.LICENSE` (the package's own file, with its copyright notice).

Do not edit the bundle. To update it, pack the new version, copy the file, and change the lines above.

`mermaid-frame.html` is the document that draws a diagram. The page frames it under a sandbox without
`allow-same-origin`. The server sends its policy as a header (see `frameCsp` in `lib/http.mjs`).
An exported round carries a copy of the frame with the bundle inside it.
