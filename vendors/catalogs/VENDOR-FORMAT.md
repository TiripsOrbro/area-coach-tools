# Vendor catalog file format

Copy an example from `vendors/examples/` to `vendors/.VendorName` (dotfile, no extension).

## Header comments

```text
# vendor: Schweppes
# location-order: BIBs | Freezes | Bottles | Cans | Other
```

Use `location-order` and a trailing **location** on each line to group stock-count tabs (e.g. Schweppes categories). Americold uses `Freezer | Fridge`.

## Item lines

```text
[buildToDays | manual] | itemCode | name | unit | unit | unit [| location …]
```

| Leading column | Meaning |
|----------------|---------|
| `10`, `7`, `13`, etc. (1–31) | Build-to days: target = ISE average daily usage × days |
| `10+2`, etc. | Days plus extra cartons on top (e.g. lettuce buffer: `10+2`) |
| `=3`, `=6`, etc. | **Fixed build-to** cartons (e.g. Schweppes BIBs); order qty still auto-calculated |
| `order=1`, `order=3`, etc. | Fixed build-to from **dashboard count**; fills **Americold Vic** scheduled order, **not** Key Item Count |
| `oh:13`, `oh:10`, etc. | **On-hand only** — not on travel-path tabs or Key Item Count; build-to = **ISE average × days**; order qty = build-to − **stock-on-hand** − **stock-on-order** (e.g. Americold dry supplies, Schweppes bottles/cans) |
| `oh:10+1`, etc. | Same as `oh:` but **extra cartons on top** of the days-based target (e.g. `oh:10+1` = ISE avg × 10 **+ 1** carton — not an 11-day build-to) |
| `manual` or `m` | Stock-count only (packaging etc.) — no Key Item Count, no auto vendor order |
| `manual=2`, `manual=1`, etc. | Stock-count with **fixed build-to** (cartons); order qty = build-to − **your count** − **stock-on-order** (same on-order deduction as `oh:`); fills scheduled orders like `order=N`. If the submitted count has **only** `manual` / `manual=` lines (no KIC items), **Send to MMX** skips Key Item Count and runs scheduled orders from your counts. |
| *(omitted)* | Use built-in rules (7-day salads, 13-day list, default 10-day) |

Unit columns use `N/a` for an unused slot (position is kept for the stock-count UI).

**Macromatix Key Item Count** maps your first three non–`N/a` columns left-to-right onto:

| Catalog column (e.g.) | MMX field |
|------------------------|-----------|
| 1st (Boxes, Cartons, …) | Closing **Box** (`tbOH1`) |
| 2nd (Bags, Packs, …) | Closing **Inner** (`tbOH2`) |
| 3rd (KGs, Each, …) | Closing **Unit** (`tbOH3`) |

Run `npm run verify-mmx-count -- 3811 --vendor americold` to confirm each item has a row **and** each count column has a matching MMX input.

## Stock count display names (optional)

Copy `vendors/examples/.display-names.example` to `vendors/.display-names` (tracked in git).

```text
# Catalog name or item code | Plain English label shown in stock count
Oil Frying Liquid | Oil
39520 | Beef cooked
```

The app shows the **second** column only. Saves, Macromatix, and build-to still use the real catalog name and code.

### Stock count code vs ISE code (Schweppes drinks)

Use the **stock count / Key Item Count** code from Macromatix as `itemCode` in `vendors/.Schweppes`. Put **ISE / order-form** codes in `vendors/.item-codes` as the third column so build-to reports still match.

### Reports vs app counts

Many items never appear on **stock-on-hand** or **stock-on-order** exports — that is normal. The flow is:

1. Count in the dashboard app (Key Item Count tabs).
2. Compare totals to **build-to** (`=N` fixed, `order=N` supplies, or `13`/`10`-day from ISE when usage exists).
3. Order shortfall via **scheduled orders** in Macromatix (lines match after you enter them).

`npm run verify-mmx-count` only flags **ISE** gaps for usage-based build-to lines; fixed/`order=` lines are skipped for report checks.

Optional trailing number after locations = **inner units per carton** (e.g. `| Carryover | 10` → 10 packs per carton). Stock count can enter cartons and packs/rolls; order qty uses the combined carton equivalent (e.g. 1 carton + 5 packs with `/10` → 1.5).

Optional **per-store build-to** token after that (see section below): `3811=+2`, `3811=10+2`, etc.

Optional **order routing** tokens (not stock-count tabs):

| Token | Meaning |
|--------|---------|
| `order:FRG` | Scheduled order goes on **Americold Vic FRG** (count tabs unchanged) |
| `order:DRY` | Scheduled order on **Americold Vic DRY** |
| `order:FRZ` | Scheduled order on **Americold Vic FRZ** |
| `no-order` | Stock count / Key Item Count only — no build-to vendor order line |
| `Key` or `key` | Explicitly on **Key Item Count** (optional marker) |
| `Daily` or `daily` | Include on **Daily Count** in the app (subset of Key Item grid rows) |

Daily count uses the same vendor files; only lines tagged with `Daily` appear on `/{store}/daily-stock-count`. Everything on daily is also on Key Item Count in Macromatix.

Example: count oil on the **Dry** tab but order on the fridge run:

```text
order=8 | 607826 | OIL FRYING LIQUID 15KG | Boxes | N/a | KGs | Dry | order:FRG
```

Nacho chips: use catalog code **39009** on the freezer run (FRZ); count on Freezer/Fridge tabs. Alias **38009** in `.item-codes` for legacy KIC rows.

### Examples

```text
10 | 3939 | 7UP BIB 15L | Boxes | N/a | N/a
13 | 39520 | Cooked Beef | Cartons | N/a | Bags | Freezer | Key | Daily
manual | 3227 | 7UP 600ml PET | Packs | N/a | Bottles
10+2 | SLETT | Lettuce | Crates | Bags | N/a
10 | DTOM4 | Tomato | Crates | KGs | N/a
```

Name-only lines (no item code) are supported for vendors like Cut Fresh.

## Item code cross-reference (when one SKU has multiple codes)

Macromatix often uses **different numbers** on the stock-count grid vs the Inventory Special Event CSV. You only need **one line per code** in `vendors/.item-codes`:

```text
Item Name | Canonical Code | Other Code
```

- **Canonical** = the `itemCode` in this vendor file (Key Item Count).
- **Other** = any code that appears in ISE, stock-on-hand, stock-on-order, or old order forms.

Example: KIC chicken is `39867A` but ISE still shows `39139`:

```text
MEAT CHICKEN COOKED | 39867A | 39139
MEAT CHICKEN COOKED | 39867A | 38501A
```

Build-to and report matching try **every code in the group**; you do not need a second catalog line.

Do **not** add lines where Other equals Canonical (e.g. `| 40303 | 40303`) — the parser ignores them.

## Per-store build-to overrides (optional)

When one store needs different build-to on a shared line, add a trailing token after locations / inner pack size:

| Token | Meaning |
|--------|---------|
| `3811=+2` | Extra cartons on top of this line’s build-to (e.g. `oh:10` stays 10-day, store 3811 adds +2) |
| `3811=10+2` | That store only: 10-day × ISE average **plus** 2 cartons |
| `3811=12` | That store only: 12-day build-to (no extra add) |

Example (3811 only wants two extra Big Bell cartons):

```text
oh:10 | 38892 | TB BIG BELL BOX 250EA | Boxes | N/a | Each | N/a | N/a | Dry | N/a | 3811=+2
```

Other stores keep the normal `oh:10` rule from the same line.

Same `itemCode` on multiple tabs (e.g. beef on Freezer and Fridge): use **one catalog line** with `| Freezer | Fridge | In Use`, not two lines with the same code.

If an item is missing from build-to, check the latest ISE CSV for the code in column `ItemCode` and add that value as an alias.

## Verify build-to

```bash
npm run build-to-order -- 3811
```

Lines with `buildToSource: catalog-days` use your file; `catalog-manual` items are excluded from auto vendor orders.
