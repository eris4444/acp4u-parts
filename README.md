# ACP4U Parts

Log customer car-parts requests one by one — customer ID and the platform it came from
(Instagram, TikTok, Facebook, WhatsApp…), phone, country / city, car brand, model, year,
VIN, the part needed, a status (New / In process / Done / Cancelled) and up to 5 photos — then export them to a styled Excel file with the
photos placed inside the cells. Every Excel file the app writes can be searched and edited
from the app.

## Install on Linux (any distribution)

```bash
curl -fsSL https://raw.githubusercontent.com/eris4444/acp4u-parts/main/install.sh | bash
```

No `curl`? Use `wget -qO- https://raw.githubusercontent.com/eris4444/acp4u-parts/main/install.sh | bash`

- No root needed — it installs for your user only (`~/.local`).
- Needs Python 3.8+, which every common distribution has; the installer adds it with your
  package manager if it is missing (apt, dnf, yum, pacman, zypper, apk, xbps, eopkg, emerge).
- Opens in its own app window when Chrome, Chromium, Brave, Edge or Vivaldi is installed
  (also as Flatpak); otherwise in your default browser.

Then open **ACP4U Parts** from the applications menu or the desktop icon, or run `acp4u-parts`.

**Update an existing install** (rows, photos and Excel files are kept):

```bash
acp4u-parts --update
```

If the `acp4u-parts` command is not found, run the install command above again — it updates in place.

| Command | What it does |
| --- | --- |
| `acp4u-parts` | open the app |
| `acp4u-parts --status` | where the data is and whether the service runs |
| `acp4u-parts --stop` | stop the background service |
| `acp4u-parts --update` | install the latest version (data is kept) |
| `acp4u-parts --version` | show the installed version |
| `acp4u-parts --uninstall` | remove the program (data is kept) |

## Where the data lives (Linux)

Everything stays on your computer in `~/ACP4U-Parts`:

- `Exports/` — every Excel export, named with date and time (`ACP4U-Parts_2026-10-01_14-30.xlsx`)
- `Backups/` — ZIP backups made with the Backup button
- `data/` — the saved rows and photos (plus one automatic copy of the rows per day in `data/history/`)

The app runs a small service that only listens on `127.0.0.1` and only answers the app window
(every request needs the install's private key). It stops by itself 30 minutes after the
window is closed.

## Windows

Download the ZIP from GitHub, unzip it, and double-click `index.html` (use Chrome or Edge).
Rows are kept in the browser; choose the app folder once with **Choose exports folder** and
exports go to `Exports\`, backups to `Backups\`. With Python installed you can instead run
`python acp4u_parts.py` to get the same disk storage as on Linux.

## Features

- Sign-in screen, English interface, works offline
- Save rows today, continue tomorrow, export when ready — each row shows whether it was exported
- Status per request — New, In process, Done, Cancelled — set in the form or changed right in the
  list; the change is also written into every exported Excel file that holds the row. In Excel the
  Status cells are coloured and offer the same four values in a drop-down
- Unfinished entries are kept as a draft if the window is closed
- Photos: click, drag & drop or paste (Ctrl+V); stored in full size, shown in a viewer
- Excel: centred cells, navy/orange design, frozen header, filters, photos inside the cells,
  print-ready landscape layout, and a hidden link back to the app row
- Search inside every exported Excel file at once — shows the file and row, with photos,
  and lets you edit the row; the change is written into the file and into the app
- Backup / restore to a single ZIP file, blank printable Excel form

---

## راهنمای فارسی

**نصب روی لینوکس** (همه توزیع‌ها، بدون نیاز به root) — این دستور را در ترمینال اجرا کنید:

```bash
curl -fsSL https://raw.githubusercontent.com/eris4444/acp4u-parts/main/install.sh | bash
```

بعد از نصب، برنامه **ACP4U Parts** در منوی برنامه‌ها و روی دسکتاپ هست؛ یا در ترمینال بنویسید `acp4u-parts`.

- همه اطلاعات در پوشه `~/ACP4U-Parts` ذخیره می‌شود: اکسل‌ها در `Exports`، پشتیبان‌ها در `Backups`.
- به‌روزرسانی (اطلاعات می‌ماند): `acp4u-parts --update` — حذف برنامه (اطلاعات می‌ماند): `acp4u-parts --uninstall`
- وضعیت هر درخواست (New / In process / Done / Cancelled) در فرم یا مستقیم در لیست قابل تغییر است و در فایل‌های اکسل هم عوض می‌شود.
- اگر Chrome یا Chromium یا Brave نصب باشد، برنامه در پنجره جداگانه مثل یک برنامه معمولی باز می‌شود.
