# Vendor catalog files

Live dotfiles in this folder (`.Americold`, `.display-names`, etc.) are **Pi-only** — not tracked in git. Edit them on the Pi (Configure items in admin, or edit the files directly). Templates live in `vendors/examples/`.

| File | Vendor |
|------|--------|
| `.Americold` | Americold |
| `.Bega` | Bega |
| `.CutFresh` | Cut Fresh |
| `.Schweppes` | Schweppes |
| `.Sands` | Sands (if configured in `custom-vendors.json` on Pi) |
| `.item-codes` | MMX ↔ order-form code map |
| `.display-names` | Plain English labels for stock count UI |

See [VENDOR-FORMAT.md](./VENDOR-FORMAT.md) for the line format (`10 | itemCode | name | …`).

Recreate locally from examples (dev only):

```powershell
Copy-Item vendors\examples\.Schweppes.example vendors\catalogs\.Schweppes
Copy-Item vendors\examples\.Americold.example vendors\catalogs\.Americold
Copy-Item vendors\examples\.Bega.example vendors\catalogs\.Bega
Copy-Item vendors\examples\.CutFresh.example vendors\catalogs\.CutFresh
Copy-Item vendors\examples\.item-codes.example vendors\catalogs\.item-codes
Copy-Item vendors\examples\.display-names.example vendors\catalogs\.display-names
```

Deploy code with `npm run pi:deploy:git` (git pull on Pi). Tar deploy (`pi:deploy`) skips these catalog files so Pi data is not overwritten from your laptop.
