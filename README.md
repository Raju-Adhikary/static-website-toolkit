# static-website-toolkit

A lightweight, file-based Static Site Generator (SSG) cum quick automation tool for Node.js with support for HTML templates, static content migration, dynamic page generation, SQLite-powered content, incremental builds, and sitemap generation.

## Features

* ⚡ Incremental builds using SHA-256 file hashing
* 📄 HTML template engine using `data-ssg` directives
* 🗂 Dynamic page generation from SQLite datasets
* 🔁 Automatic stale file cleanup
* 🎯 Template variables and reusable components
* 📦 HTML, CSS, JS and JSON minification
* 🧩 SQLite integration
* 🗺 Automatic XML and HTML sitemap generation
* 🚀 Fast rebuilds by compiling only modified files

## Directory Structure

```text
project/
│
├── public_old/          # Source website
├── build/               # Generated output
├── templates/           # HTML template fragments
├── data/                # SQLite databases & JSON files
├── .ssg-changes.json    # Build cache
└── ssg.js
```

## Installation

```bash
git clone <repository-url>
cd <project>

npm install
```

Required packages:

```bash
npm install jsdom prettier esbuild html-minifier-terser
```

Requires Node.js with:

* `node:sqlite`
* `crypto`
* `fs`
* `path`

## Usage

Build the website:

```bash
node ssg.js build
```

Generate sitemap:

```bash
node ssg.js sitemap
```

## Configuration

Edit the constants near the top of `ssg.js`.

```js
const SOURCE_PATH = "public_old";
const DEST_PATH = "build";
const TEMPLATES_PATH = "templates";
const DATA_PATH = "data";
const BASE_URL = "https://example.com";
```

Enable or disable build engines:

```js
const ACTIVE_ENGINES = {
    migrate: 0,
    renderTemplate: 1,
    dynamicLink: 1
};
```

## Template Engine

Templates are rendered using the `data-ssg` attribute.

Example:

```html
<div data-ssg="template header"></div>
```

Variables:

```html
<span data-ssg="getVar page.title"></span>
```

Loop:

```html
<ul data-ssg="loop posts --as=post">
    ...
</ul>
```

Condition:

```html
<div data-ssg="if user.loggedIn">
    Welcome!
</div>
```

Supported directives include:

* `template`
* `getVar`
* `setVar`
* `loop`
* `if`
* `else`
* `with`
* `sqlite`
* `canonical`
* `setAttr`
* `year`
* `pageUrl`

## Dynamic Pages

Pages can be generated from datasets using the `dynamicLink` directive.

Example:

```text
[!dynamicLink sqliteQuery "blog/[slug]/index.html" --db=blog.db --query=* FROM posts]
```

Each record returned by the controller generates a separate HTML page.

## SQLite Support

Templates can directly execute SQLite queries.

Example:

```html
<div data-ssg="sqlite blog.db --as=posts">
SELECT * FROM posts;
</div>
```

The query result becomes available inside the template context.

## Incremental Build

The generator stores file hashes in:

```text
.ssg-changes.json
```

Only modified files are rebuilt, making subsequent builds significantly faster.

## Output Processing

During build:

* HTML is minified
* CSS is minified
* JavaScript is minified
* JSON is compacted
* Removed source files are automatically deleted from the build directory

## Sitemap

Generate:

```bash
node ssg.js sitemap
```

Outputs:

* `build/sitemap.xml`
* `build/sitemap.html`

## Requirements

* Node.js 22+
* SQLite support (`node:sqlite`)

## License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**.

You are free to use, modify and distribute this software under the terms of the GPL-3.0 license. Any derivative work distributed publicly must also be licensed under GPL-3.0 and its source code must be made available.

For details, see the `LICENSE` file or visit the GNU GPL-3.0 license page: https://www.gnu.org/licenses/gpl-3.0.html

