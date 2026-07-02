process.chdir(__dirname);
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sqlite = require("node:sqlite");

/*=================================
// NOTE: 
// search "CONFIG" and "uncomment to activate" to find hidden configurable properties 
==================================*/

const HASH_DB_FILE = ".ssg-changes.json"; // store for file changes

const TestMode = false; // dynamicLink wont explode + hash tracker won't delete stale files
const SOURCE_PATH = "public_old";
const DEST_PATH = "build";
const TEMPLATES_PATH = "templates"
const DATA_PATH = "data"
const BASE_URL = "https://example.web.app"
const ACTIVE_ENGINES = {
    "migrate": 0,
    "renderTemplate": 1,
    "dynamicLink": 1
}
const LIMITED_FILES = {
    // only look at these files
    // better to directly copy from HASH_DB_FILE (if possible)
    // start include SOURCE_PATH
    active : false,
    files : [
        "public_old/mock-test/dynamicTest[].html"
    ]
}

const IGNORE_FILES = {
    // don't compile or track these files
    // better to directly copy from HASH_DB_FILE
    // start include SOURCE_PATH
    active : false,
    files : [
        "public_old/mock-test/dynamicTest[].html"
    ]
}



const systemCommand = process.argv[2];
if(!systemCommand) console.log(`
Usage: node ssg.js [command]
   build                   compile template/migrate and produce build html
   sitemap                 generate sitemap
`);
// manages multiple database in single place
const SQLITE_DB_MAP = new Map();
function SQLITE_DB(file) {
    if (!SQLITE_DB_MAP.has(file)) {
        const dbPath = path.join(DATA_PATH, file);
        const handle = new sqlite.DatabaseSync(dbPath, { readonly: true });
        SQLITE_DB_MAP.set(file, handle);
    }
    return SQLITE_DB_MAP.get(file);
}

//// clean destination first
//// uncomment to activate
// fs.rmSync(DEST_PATH, { recursive: true, force: true });
// fs.rmSync(HASH_DB_FILE, { recursive: true, force: true });

class FileTracker {
    constructor(dbFile) {
        this.dbFile = dbFile;

        const defaultDb = { static: {}, dynamic: {} };
        let loadedDb = {};

        if (fs.existsSync(dbFile)) {
            try {
                loadedDb = JSON.parse(fs.readFileSync(dbFile, "utf8"));
            } catch {
                loadedDb = defaultDb;
            }
        }
        
        this.db = { ...defaultDb, ...loadedDb }; // for live update
        this.olddb = structuredClone(this.db); // store past stat

        this.staleStatic = new Set();
        this.staleDynamic = new Map();
        
        if (!TestMode) {
            this.staleStatic = new Set(Object.keys(this.db.static));
            
            if(ACTIVE_ENGINES.dynamicLink) for (const [host, children] of Object.entries(this.db.dynamic)) {
                this.staleDynamic.set(host, new Set(children));
            }
        }
        
        for (const f of this.staleStatic) isExcludedFile(f) && this.staleStatic.delete(f);
        for (const [f] of this.staleDynamic) isExcludedFile(f) && this.staleDynamic.delete(f);
    }

    save() {
        fs.mkdirSync(path.dirname(this.dbFile), { recursive: true });
        fs.writeFileSync( this.dbFile, JSON.stringify(this.db, null, 2) );
    }

    hashify(str) {
        // str - string or instance of buffer
        return crypto.createHash("sha256").update(str).digest("hex");
    }

    hashFile(filePath) {
        return this.hashify(fs.readFileSync(filePath));
    }

    hasStaticChanged(filePath, update = false) {
        const newHash = this.hashFile(filePath);
        const oldHash = this.olddb.static[filePath];
        const changed = oldHash !== newHash;
        
        if (changed && update) {
            this.db.static[filePath] = newHash;
            // this.save();
        }
        
        return changed;
    }
    
    stageStatic(filePath) {
        if (!fs.existsSync(filePath)) {
            if (filePath in this.db.static) {
                delete this.db.static[filePath];
                // this.save();
                return -1; // Deleted/Missing
            } 
            return 0;
        }
        
        this.staleStatic.delete(filePath);

        if (!(filePath in this.db.static)) {
            console.log("[+]", "New static file staged : ", filePath);
        }

        return this.hasStaticChanged(filePath, true);
    }
    
    hasDynamicChanged(hostPath, filePath) {
        // Mark the child as seen
        this.staleDynamic.get(hostPath)?.delete(filePath);
        
        const hostChanged = this.hasStaticChanged(hostPath);
        const newChild = !this.olddb.dynamic[hostPath]?.includes(filePath);
        
        return hostChanged || newChild;
    }
    
    stageDynamic(hostPath, filePath) {
        // Mark the child as seen
        this.staleDynamic.get(hostPath)?.delete(filePath);

        this.db.dynamic[hostPath] ??= [];

        if (!this.db.dynamic[hostPath].includes(filePath)) {
            console.log("[+]", "New dynamic file staged : ", filePath);
            this.db.dynamic[hostPath].push(filePath);
            // this.save();
            return 1;
        }

        return 0;
    }
}

async function transformContent( {
    input,
    type,
    mode, // "minify" | "prettify"
    isFile = false,
    disabled = false
}) {
    // CONFIG - transformContent
    const engines = {
        prettier: {
            options: {
                tabWidth: 4,
                printWidth: 999,
                semi: true,
                singleQuote: false,
            },

            async run(content, type) {
                const prettier = require("prettier");

                return prettier.format(content, {
                    ...this.options,
                    parser: {
                        html: "html",
                        js: "babel",
                        css: "css",
                        json: "json",
                    }[type],
                });
            },
        },

        esbuild: {
            options: {
                minify: true,
                minifyWhitespace: true,
                minifyIdentifiers: true,
                minifySyntax: true,
            },

            async run(content, type) {
                const esbuild = require("esbuild");

                return (
                    await esbuild.transform(content, {
                        ...this.options,
                        loader: {
                            js: "js",
                            css: "css",
                            json: "json"
                        }[type],
                    })
                ).code;
            },
        },

        htmlMinifier: {
            options: {
                collapseWhitespace: true,
                removeComments: true,
                minifyCSS: true,
                minifyJS: true,
            },

            async run(content) {
                const { minify } = require("html-minifier-terser");
                return minify(content, this.options);
            },
        },

        jsonParse: {
            async run(content) {
                const jsonObject = JSON.parse(content);
                return JSON.stringify(jsonObject);
            }
        }
    };

    const routes = {
        prettify: {
            html: "prettier",
            js: "prettier",
            css: "prettier",
            json: "prettier",
        },

        minify: {
            html: "htmlMinifier",
            js: "esbuild",
            css: "esbuild",
            json: "jsonParse",
        },
    };

    const content = isFile ? require("fs").readFileSync(input, "utf8"): input;

    const engineName = routes[mode]?.[type];

    if (disabled || !engineName) return content;

    return engines[engineName].run(content, type);
}

function isIterable(value) {
  return value != null && typeof value[Symbol.iterator] === 'function';
}

function renderCommand(commandStr) {
    const matches = commandStr.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    const result = { command: matches[0], args: [], flags: {} };

    for (let i = 1; i < matches.length; i++) {
        let t = matches[i].replace(/^(['"])(.*)\1$/, '$2').replace(/~/g, " ");
        let m = t.match(/^--([^=]+)=?(.*)$/);
        
        if (m) {
            result.flags[m[1]] = m[2] || true; // boolean flag if no value
        } else {
            result.args.push(t);
        }
    }
    return result;
    // OUTPUT: { command: matches[0], args: [], flags: {} }
    // "~" can be used as a substitute of <space> OR wrap with single or double quote
}

function getJsonByPath(data, inputStr) {
    /**
      Reads nested JSON/object values using dot notation and applies scoped string filters.
      Syntax format: "path.to.property | filterName" or "filename.json:path.to.property | filterName"
      * @param {Object} data - The initial data object.
      @param {string} inputStr - The path string with optional file and filter.
      @returns {*} The processed value or an empty string.
     */
    let rawStr = inputStr?.trim();
    if (!rawStr) return "";
    
    const ALLOWED_FILTERS = {
        "slugify" : cleanFileName,
        "formatDate" (dateStr) {
          return new Date(dateStr).toLocaleDateString("en-IN", {
            day: "numeric",
            month: "long",
            year: "numeric",
          });
        },
        "formatTimeRange" (timeStr) {
          const [sh, sm, eh, em] = timeStr.split(":");
        
          const formatTime = (h, m) =>
            new Date(0, 0, 0, h, m).toLocaleTimeString("en-IN", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: true,
            }).toUpperCase();
        
          return `${formatTime(sh, sm)} - ${formatTime(eh, em)}`;
        },
        
        /*---------------------------------------*/
        "cleanTradeName" (tradeName) {
          return tradeName.replace("(NSQF)","");
        }
    }

    let filterName = null;
    
    function applyFilter(value, filterName) {
        if (!filterName) return value;
        if (Object.prototype.hasOwnProperty.call(ALLOWED_FILTERS, filterName)) {
            return ALLOWED_FILTERS[filterName](value);
        }
        return value;
    }

    // Extract the filter if present
    if (rawStr.includes("|")) {
        const parts = rawStr.split("|");
        rawStr = parts[0].trim();
        filterName = parts[1]?.trim();
    }

    if (rawStr === ".") return applyFilter(data, filterName);

    let targetData = data;
    let objectPath = rawStr;

    if (rawStr.includes(":")) {
        const colonIndex = rawStr.indexOf(":");
        const file = rawStr.slice(0, colonIndex);
        objectPath = rawStr.slice(colonIndex + 1);

        try {
            const filePath = path.join(DATA_PATH, file);
            targetData = JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch {
            return ""; // Graceful fallback on file error
        }
    }

    let result = targetData;
    if (objectPath && objectPath !== ".") {
        result = objectPath
            .split(".")
            .filter(Boolean)
            .reduce((acc, key) => acc?.[key], targetData);
    }

    const finalValue = result ?? "";

    return applyFilter(finalValue, filterName);
}

function cleanFileName(str) {
  if(typeof str !== "string") return str;
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-_]/g, ' ')   // remove weird chars
    .replace(/\s+/g, '-')            // spaces → dash
    .replace(/-+/g, '-')             // merge multiple dashes
    .replace(/^-+|-+$/g, '');        // trim leading/trailing dashes
}

function strMatchesAnyRule(path, rules) {
    // String - "path" 
    // Set - rules[] [supports: string , regex or function]
    return rules.some(w =>
        typeof w === "function" ? w(path) :
        w instanceof RegExp ? w.test(path) :
        path.includes(w)
    )
}

function safeRemoveEmptyDir(dir) {
    try{
        if (fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
            safeRemoveEmptyDir( path.dirname(dir) );
            return true;
        }
    } catch {}
    return false;
}

function scanDir(dirPath, fileType, callback) {
  // scan files in all nested directories
  if (!fs.statSync(dirPath).isDirectory()) return dirPath;

  const result = {};
  const items = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);

    if (item.isDirectory()) {
      const subDir = scanDir(fullPath, fileType, callback);
      if (Object.keys(subDir).length) {
        result[item.name] = subDir;
      }
      continue;
    }

    if (fileType && !item.name.includes(fileType)) continue;

    result[item.name] = fullPath;

    if (callback) {
      callback(fullPath);
    }

    //return result; //pause/break
  }

  return result;
}

function parseHTML(window, fullPath, globalCTX) {
    const { document } = window;
    if (!document.title) {
        console.log("\x1b[37m\x1b[41m%s\x1b[0m" , "(forbidden)")
        return false;
    }
    process.stdout.write("....");
    
    function htmltofrag(content) {
        // raw html(STRING) to fragment(rendered html)
        // note equal to DOM , as don't have single container to target
        const range = document.createRange();
        const frag = range.createContextualFragment(content);
        return frag;
    }
    
    function decodeHtml(html) {
        // decode html entities [&lt;] = [<]
        const txt = document.createElement("textarea");
        txt.innerHTML = html;
        return txt.value;
    }

    function encodeHtml(str) {
        // encode html entities [<] = [&lt;]
        return new Option(str).innerHTML;
    }
    
    function htmltodom(content, rootTag="div") {
        // Convert raw HTML string → rendered DOM
        // Uses a temporary <div> container.
        // After processing, `.innerHTML` returns only the parsed content,
        // excluding the wrapper <div> itself.
        //
        // Useful for manipulating HTML strings through the DOM,
        // though the final result still needs to be extracted back as a string
        // using `.innerHTML`.
        const root = document.createElement(rootTag);
        root.innerHTML = content;
        return root;
    }

    // CONFIG - migration
    (ACTIVE_ENGINES.migrate) && ( function renderMigrate() {
        let extractedData = {
            title: document.title,
            meta: [],
            script: [],
            linkCSS: []
        };
    
        document.querySelectorAll("meta").forEach((o) => {
            return;
            if(o.getAttribute("charset")) return;
            const name = o.getAttribute("name") || o.getAttribute("property");
            
            o.removeAttribute("name");
            o.removeAttribute("property");
            
            o.setAttribute(name.includes("og:") ? "property" : "name", name)
            
            //extractedData.meta.push({});
        });




        document.querySelectorAll(".theme-header").forEach((o) => {
            const c = '<span data-ssg="template header"></span>';
            o.replaceWith( htmltofrag(c) );
        })
        document.querySelectorAll(".theme-footer").forEach((o) => {
            const c = '<span data-ssg="template footer"></span>';
            o.replaceWith( htmltofrag(c) );
        })
        document.querySelectorAll("meta").forEach((o) => {
            const list = ["utf-8","viewport","msvalidate.01","google-site-verification","author", "robots", "geo.placename", "rating", "geo.country", "og:site_name", "og:locale", "og:locale:alternate", "og:type", "website:author", "og:site_name", "og:url"];
            const name = o.getAttribute("name") || o.getAttribute("property") || o.getAttribute("charset");
            if(!list.includes(name)) return;
            o.remove();
        })
        document.querySelectorAll("link").forEach((o) => {
            const list = ["icon","manifest"];
            if(!list.includes( o.getAttribute("rel") )) return;
            o.remove();
        })
        document.querySelectorAll("head").forEach((o) => {
            const c = '\n<meta data-ssg="template meta">';
            o.prepend( htmltofrag(c) );
        })
    
    
        let isQuiz = false;
        document.querySelectorAll(".load-plugin").forEach((o) => {
            const c = '<span data-ssg="template pluginblock_quiz">';
            o.replaceWith( htmltofrag(c) );
            isQuiz = true;
        })
        document.querySelectorAll("title").forEach((o) => {
            const c = '\n<meta data-ssg="template headscript' + (isQuiz ? "_quiz" : "") + '">';
            o.after( htmltofrag(c) );
        })
        document.querySelectorAll("main").forEach((o) => {
            const c = '\n<span data-ssg="template footscript' + (isQuiz ? "_quiz" : "") + '">';
            o.after( htmltofrag(c) );
        })
    
        document.querySelectorAll("body").forEach((o) => {
            return;
            const c = '';
            o.replaceWith( htmltofrag(c) );
        })
        
    
    
    
    
        
        document.querySelectorAll("[href],[src]").forEach((o) => {
            // List all urls
            return;
            console.log(o.getAttribute("href") || o.getAttribute("src"))
        })

    })();


    let maxrun = 20; // limits recursion depth , increase if required
    // templates rendering
    (ACTIVE_ENGINES.renderTemplate) && (function renderTemplate(root, ctx) {
        if(--maxrun < 0) return;

        function getTemplateElements (root) {
            return [...root.querySelectorAll("[data-ssg]")]
            .filter(el => !el.parentElement.closest('[data-ssg]'));
        }

        getTemplateElements(root).forEach((o) => {
            const attr = renderCommand(o.dataset.ssg);
            const command = attr.command;
            let templateContent = "";

            // CONFIG - template commands
            const directives = {
                template() {
                    // GET TEMPLATE CHUNKS FROM FILE
                    // data-ssg="template <*name>"
                    
                    const templateName = attr.args[0].trim();
                    const templatePath = path.join(TEMPLATES_PATH, templateName + ".html");

                    if(fs.existsSync(templatePath)) {
                        const html = fs.readFileSync(templatePath);
                        return renderTemplate( htmltodom(html), ctx ).innerHTML;
                    }else{
                        console.warn(" ⚠️ ", "[cmd - template] template not found :: ", templatePath);
                        return "";
                    }
                },
                year: "" + new Date().getUTCFullYear(),
                pageUrl: BASE_URL.replace(/\/$/, "") + "/" + path.relative(SOURCE_PATH, fullPath).replace(/\\/g, "/").replace(/index\.html$/i, ""),
                canonical() {
                    // THE CANONICAL <LINK> ELEMENT
                    // data-ssg="canonical"
                    
                    return `<link href="${this.pageUrl}" rel="canonical">`
                },
                setAttr() {
                    // SETS DINAMIC ATTRIBUTE FROM VARIABLE
                    // data-ssg="setAttr <*attrName> '--<attribute name>=<attribute value>'"
                    // use "?" for conditional implementation , e.g. '--class?cond=red?cond.red yellow green?cond.green'
                    // use "+=" if you want to add to existing attribute , maybe just like in [class]
                    
                    const attrs = attr.flags;
                    
                    for (const [rawKey, rawValue] of Object.entries(attrs)) {
                        const isAppend = rawKey.endsWith("+");
                        const cleanKey = isAppend ? rawKey.slice(0, -1) : rawKey;
                        const [attrKey, keyCond] = cleanKey.split("?");
                    
                        if (keyCond && !getJsonByPath(this, keyCond)) continue;
                    
                        let finalValue = "";
                    
                        if (rawValue.includes("{{")) {
                            // --- TEMPLATE MODE ---
                            finalValue = rawValue.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
                                return getJsonByPath(this, path.trim()); 
                            });
                        } else {
                            // --- TOKEN MODE ---
                            finalValue = rawValue.split(/\s+/)
                                .map((part) => {
                                    const [val, valCond] = part.split("?");
                                    if (valCond && !getJsonByPath(this, valCond)) return ""; 
                                    
                                    return getJsonByPath(this, val) || val;
                                })
                                .filter(Boolean)
                                .join(" ");
                        }
                    
                        if (isAppend) {
                            const existingValue = o.getAttribute(attrKey) || "";
                            finalValue = existingValue ? `${existingValue} ${finalValue}` : finalValue; 
                        }
                    
                        if (finalValue) o.setAttribute(attrKey, finalValue);
                    }
                    
                    o.removeAttribute("data-ssg");
                    return renderTemplate( htmltodom(o.outerHTML), ctx ).innerHTML;
                },
                getVar() {
                    // GET VARIABLE
                    // data-ssg="getVar <*variable path tied to this>"
                    // --preserveTag    // preserve the host element tag instead of replacing it
                    // --text           // [TODO] data treated as textContent

                    const variableKey = attr.args[0];
                    const doPreserveTag = attr.flags["preserveTag"] == true;
                    let data = "";
                    
                    if (variableKey.includes("{{")) {
                        data = variableKey.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
                            return getJsonByPath(this, path.trim()); 
                        });
                    } else {
                        data = getJsonByPath(this, variableKey);
                    }
                    
                    if(doPreserveTag){
                        o.innerHTML = data;
                        o.removeAttribute("data-ssg");
                        data = o.outerHTML;
                    }
                    
                    return renderTemplate(
                        htmltodom(
                            typeof data == "object" ?  JSON.stringify(data) : data
                        ), ctx 
                    ).innerHTML;
                },
                setVar() {
                    // SET innerHTML as VARIABLE
                    // data-ssg="setVar"
                    // --as=<variable name>     // *where the data will be stored
                    // --type=<text|json>       // *specify how to parse the data
                    // --rendernow              // render content before storing
                    // --keep                   // keep original innerHTML

                    const storeAs = attr.flags["as"];
                    const type = attr.flags["type"] || "text";
                    const doRenderNow = attr.flags["rendernow"] == true;
                    const doKeep = attr.flags["keep"] == true;
                    const html = o.innerHTML;
                    const renderedContent = doRenderNow ? renderTemplate( htmltodom(html), ctx ).innerHTML : false;
                    if(typeof ctx !== "object") ctx = {};

                    ctx[storeAs] = ({
                        text : renderedContent || html,
                        get json() { return JSON.parse(this.text) }
                    })[type] || console.warn("⚠️", "[cmd - setVar] unknown type - " ,type);

                    return doKeep ? ctx[storeAs] : "";
                },
                debugPrint() {
                    let message = this.getVar();
                    console.log(message);
                    return message;
                },
                sqlite() {
                    // SET VARIABLE FROM SQLITE OUTPUT
                    // data-ssg="sqlite <*database path>"
                    // --as=<variable name>     // *where the data will be stored
                    // innerHTML is the query   // e.g. SELECT * FROM users
                    
                    const dbPath = attr.args[0];
                    const storeAs = attr.flags["as"];
                    const query = decodeHtml( renderTemplate( htmltodom(o.innerHTML), ctx).innerHTML.trim() );
                    if(typeof ctx !== "object") ctx = {};
                    
                    // console.log(query)
                    
                    ctx[storeAs] = SQLITE_DB(dbPath).prepare(query).all();
                    return "";
                },
                if() {
                    const dataRoot = getJsonByPath(this , attr.args[0]);
                    const html = o.innerHTML;
                    const localCTX = (ctx && typeof ctx == "object") ? {...ctx} : {};
                    localCTX["_childOfIf"] = true;
                    
                    if (dataRoot) {
                        localCTX["_childOfIf_state"] = true;
                        return renderTemplate( htmltodom(html), localCTX ).innerHTML;
                    } else {
                        localCTX["_childOfIf_state"] = false;
                        const html2 = getTemplateElements( htmltodom(html) )
                        .filter(el => renderCommand(el.dataset.ssg).command == "else")
                        .map(el => el.outerHTML).join("");
                        return renderTemplate( htmltodom(html2), localCTX ).innerHTML;
                    }
                    return "";
                },
                else() {
                    const html = o.innerHTML;
                    const localCTX = (ctx && typeof ctx == "object") ? {...ctx} : {};
                    if(!this["_childOfIf"]){
                        console.warn(" ⚠️ ", '"else" only works inside "if"')
                        return undefined;
                    } localCTX["_childOfIf"] = false;
                    
                    if(this["_childOfIf_state"]) return "";
                    
                    return renderTemplate( htmltodom(html), localCTX ).innerHTML;
                    
                },
                with() {
                    // CREATE LOCAL ENV
                    // data-ssg="with <*data: variable tied to this>"
                    // --as=<variable name>, where the local data will be stored, default : "_scope"

                    const dataRoot = getJsonByPath(this , attr.args[0]);
                    const storeAs = attr.flags["as"];
                    const html = o.innerHTML;

                    const localCTX = (ctx && typeof ctx == "object") ? {...ctx} : {};
                    localCTX[storeAs || "_scope"] = dataRoot;
                    return renderTemplate( htmltodom(html), localCTX ).innerHTML;
                },
                loop() {
                    // LOOPS THROUGH OBJECT
                    // data-ssg="loop <*data: variable tied to this>"
                    // --as=<variable name> where the data will be stored, default : "_scope"

                    let op = "";
                    let dataRoot = getJsonByPath(this , attr.args[0]);
                    if(typeof dataRoot === "string") { 
                        try { dataRoot = JSON.parse(dataRoot) } catch {};
                        if(typeof dataRoot === "string"){ dataRoot = [dataRoot] };
                    };
                    const storeAs = attr.flags["as"] || "_scope";
                    const html = o.innerHTML;
                    
                    for (let j in dataRoot) {
                        const localCTX = (ctx && typeof ctx == "object") ? {...ctx} : {};
                        localCTX[storeAs] = dataRoot[j];
                        localCTX[storeAs + "_key"] = j;
                        op += renderTemplate( htmltodom(html), localCTX ).innerHTML;
                    }
                    return op;
                },
                "Examples": "Example global variable"
            }
        
            ctx && Object.assign(directives, ctx);
            
            let cmd = ((d, c, r) => (r = getJsonByPath(d, c)) && (typeof r == "function" ? r.bind(d) : r))(directives, command);

            if(typeof cmd !== "undefined"){
                templateContent = typeof cmd == "function" ? cmd() : cmd;
                if(typeof templateContent == "object" && !templateContent?.nodeType){
                    templateContent = JSON.stringify(templateContent, null , 2)
                }
            } else {
                console.warn(" ⚠️ ", "command not found :: ", command);
            }
            
            
            o.replaceWith( htmltofrag(templateContent.trim()) );

        });
        if(root.querySelectorAll("[data-ssg]").length) console.warn("⚠️", "some data-ssg not rendered");
        //if(root.querySelectorAll("[data-ssg]").length) renderTemplate();
        maxrun++;
        return root;
    })(document , globalCTX);
    
    





    
    //return String(document.body.outerHTML);
    
    return String(document.documentElement.outerHTML);
    //return JSON.stringify(extractedData, null, 1);
}

function handleHTML(fullPath, outputPath, writeOutputCB){
    const fileContent = fs.readFileSync(fullPath, "utf8").trim();
    
    // [!dynamicLink DLcontrollerName "DLoutputPath/[slug]/t/p-[slug].html"]
    const isDynamicLink = fileContent.split("\n",1)[0].match(/^\[!dynamicLink\s+((?:[^\]"']|"[^"]*"|'[^']*')+)](.*)/);
    // WARNING: removes the first line.
    // Assumes dynamicLink directive is always the first line.
    const fileMainContent = isDynamicLink ? fileContent.replace(/^.*\r?\n/, "") : fileContent;

    if(!ACTIVE_ENGINES.dynamicLink || !isDynamicLink) {
        // normal page
        
        //// uncomment to activate
        //// skip if static file not changed
        //// NOTE that doesn't check dependencies
        if(!fileTracker.hasStaticChanged(fullPath)) return;
        
        const dom = new JSDOM(fileMainContent , {
            runScripts: undefined,
            resources: undefined,
            pretendToBeVisual: false
        });
        const parsedHTML = parseHTML(dom.window, fullPath);
        writeOutputCB([outputPath, parsedHTML ? "<!doctype html>\n"+parsedHTML : fileMainContent]);
        dom.window.close();
        
        return;
    }
    
    const DLparams = renderCommand( isDynamicLink[1] );
    const DLparamFlags = DLparams.flags;
    const DLcontrollerName = DLparams.command;
    const DLoutputPath = DLparams.args[0];
    
    if( !(DLoutputPath && DLcontrollerName) ){
        console.warn( "⚠️"," DLoutputPath && DLcontrollerName not provided, exit!!");
        return;
    }
    
    // CONFIG - dynamicLink controllers
    const DLcontrollers = {
        testController () {
            return [{
                t : "fa:)",
                p: "prime"
            },
                {
                t : "sa",
                p: "prime2"
            }]
        },
        sqliteQuery () {
            if (!DLparamFlags.db) {
                console.warn("⚠️", "[DLcontrollers]", "sqliteQuery requires a --db flag");
                return [];
            }

            const stmt = SQLITE_DB(DLparamFlags.db).
                prepare("SELECT " + DLparamFlags.query);
            return stmt.all();
        },
        jsonQuery () {}
    }
    
    if(!DLcontrollers[DLcontrollerName]){
        console.warn( "⚠️"," DLcontroller not found :", DLcontrollerName, " exit!!");
        return;
    }
    
    const dataset = DLcontrollers[DLcontrollerName]();
    
    let DLpageNo = 0;
    if(isIterable(dataset)){
        for(let j of dataset){
            DLpageNo++;
            const pageData = j;
            
            const DLrenderedOP = DLoutputPath.replace(/\[([^\]]+)\]/g, (_, k) => cleanFileName(pageData[k]) ?? `[${k}]`);
            const inPath = path.join(path.dirname(fullPath), DLrenderedOP);
            const outPath = path.join(path.dirname(outputPath), DLrenderedOP);
            
            //// uncomment to activate
            //// skip if dynamic file already exist in record
            //// NOTE that only track hostPath file change
            if(!fileTracker.hasDynamicChanged(fullPath, inPath)) continue;
            
            process.stdout.write(`\rDynamic Link - ${DLpageNo}: ${inPath}`);
            
            const dom = new JSDOM(fileMainContent, {
                runScripts: undefined,
                resources: undefined,
                pretendToBeVisual: false
            });
            
            const parsedHTML = parseHTML(dom.window, inPath, { _DL : pageData });
            writeOutputCB([outPath, parsedHTML ? "<!doctype html>\n"+parsedHTML : fileMainContent]);
            dom.window.close();
            
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            
            // stage updeted file
            fileTracker.stageDynamic(fullPath, inPath);
            
            if(TestMode) {
                console.log( "[TestMode] ", "only one dynamicLink compiled for testing", outPath);
                break;
            };
        }
    } else { console.warn( "⚠️"," DLcontroller returned invalid data."); }
    
    console.log("Successfully generated ", DLpageNo, " dynamic pages...")
}

function renderByFilePath(fullPath) {
    // CONFIG - Parmanent Exclusion
    if (strMatchesAnyRule( fullPath, [
        ".git" 
    ])) return;

    // temporary Exclusion
    if(isExcludedFile(fullPath)) return;
    
    const isFileChanged = fileTracker.hasStaticChanged(fullPath);
    const fullPathExt = path.extname(fullPath);
    const outputPath = path.join(DEST_PATH, path.relative(SOURCE_PATH, fullPath));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    
    // CONFIG - just copy as it is
    const onlyCopy = [".lab", "404.html"].
    some(w => fullPath.split("/").includes(w));
    
    if((fullPathExt !== ".html") && !isFileChanged) {
    } else if(!manageByExt[fullPathExt] || onlyCopy){
        // copy all others
        fs.copyFileSync(fullPath, outputPath);
    } else if (typeof manageByExt[fullPathExt] == "function"){
        manageByExt[fullPathExt]({fullPath, outputPath});
    }
    
    // stage update
    fileTracker.stageStatic(fullPath);
    
    // commit file changes
    fileTracker.save();
}

function isExcludedFile (filePath) {
    // CONFIG - Exclusion conditions
    return LIMITED_FILES.active && !strMatchesAnyRule(filePath, LIMITED_FILES.files) ||
    IGNORE_FILES.active && strMatchesAnyRule(filePath, IGNORE_FILES.files);
}

// CONFIG - extension wise file handlers
const manageByExt = {
    _commonProfile1 (inPath, outPath, type, disable = false) {
        // css, js, json
        transformContent({
          input: inPath,
          type: type,
          mode: 0 ? "prettify" : "minify",
          isFile: true,
          disabled: disable
        }).then( res => {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, res);
        })
    },
    ".html" (p) {
        console.log("\x1b[36m\x1b[40m%s\x1b[0m", "├─ " + p.fullPath);

        handleHTML(p.fullPath, p.outputPath, (res) =>{
            const [outPath, html] = res;
            
            // ====== minify and save ======//
            transformContent({
              input: html,
              type: "html",
              mode: 0 ? "prettify" : "minify",
              isFile: false,
              disabled: false
            }).then( res => {
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
                fs.writeFileSync(outPath, res);
            })
        });
        
        
        if (global.gc) global.gc();
        console.log("memoryUsage::",
        " rss -" , Math.round(process.memoryUsage().rss / 1e6), "MB",
        ", heap -" , Math.round(process.memoryUsage().heapUsed / 1e6), "MB");
    },
    ".css" (p) {
        this._commonProfile1( p.fullPath, p.outputPath, "css" );
    },
    ".js" (p) {
        this._commonProfile1( p.fullPath, p.outputPath, "js" );
    },
    ".json" (p) {
        this._commonProfile1( p.fullPath, p.outputPath, "json" );
    }
}

const fileTracker = new FileTracker(HASH_DB_FILE);

if(systemCommand == "build"){
    scanDir(SOURCE_PATH , "", renderByFilePath);
    (() => {
        //==============================================
        // resolve files that not seen in entire process 
        // but previusly seen
        //==============================================
    
        // Helper for resolving paths
        function getOutputPath(filePath) {
            return path.join(DEST_PATH, path.relative(SOURCE_PATH, filePath));
        }
        
        // 1. Resolve Stale Dynamic Files
        for (const [hostPath, staleChildren] of fileTracker.staleDynamic.entries()) {
            staleChildren.forEach((staleChild) => {
                const outputPath = getOutputPath(staleChild);
                
                // Remove the missing child from the filesystem
                if (fs.existsSync(outputPath)) {
                    fs.unlinkSync(outputPath);
                }
                
                safeRemoveEmptyDir(path.dirname(outputPath));
        
                // Remove the missing child from the database array safely
                if (fileTracker.db.dynamic[hostPath]) {
                    fileTracker.db.dynamic[hostPath] = fileTracker.db.dynamic[hostPath].filter(f => f !== staleChild);
                }
                
                console.log("🛑", "[REMOVED] dynamic stale file:", outputPath);
            });
        
            // Clean up the host entry entirely if it no longer generates any files
            if (fileTracker.db.dynamic[hostPath] && fileTracker.db.dynamic[hostPath].length === 0) {
                delete fileTracker.db.dynamic[hostPath];
            }
        }
        
        // 2. Resolve Stale Static Files
        fileTracker.staleStatic.forEach((filePath) => {
            const state = fileTracker.stageStatic(filePath);
            const outputPath = getOutputPath(filePath);
            
            // Expected: file is confirmed missing (-1)
            if (state === -1) {
                
                if (fs.existsSync(outputPath)) {
                    fs.unlinkSync(outputPath);
                }
        
                const dirPath = path.dirname(outputPath);
                safeRemoveEmptyDir(dirPath);
        
                console.log("🛑", "[REMOVED] stale static file:", filePath);
            } else {
                console.warn("⚠️", "Stale file invalid:", filePath, "state:", state);
            }
        });
        
        // Final save to lock in all deletions
        fileTracker.save();
    })();
}


//==============================================
// GENERATE SITEMAP
//==============================================
function generateSitemap() {
    const urls = [];
    
    function extractTitle(html) {
        if (!html || typeof html !== "string") return false;
        const match = html.match(/<title[^>]*>(.*?)<\/title>/is);
        return match && match[1].trim();
    }

    scanDir(DEST_PATH, ".html", (fullPath) => {
        if (
            fullPath.endsWith("404.html") ||
            fullPath.includes(".lab") ||
            fullPath.endsWith("sitemap.html")
        ) return;

        const html = fs.readFileSync(fullPath, "utf8");
        if(html.split("\n",1)[0].includes("dynamicLink")) return;
        const title = extractTitle(html);
        if (!title) return;

        let rel = path.relative(DEST_PATH, fullPath);
        const url = BASE_URL.replace(/\/$/, "") +
            (rel ? "/" + rel : "");
        urls.push([url, title]);
            
    });

    const sitemapXML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([u])=> `<url><loc>${u}</loc></url>`).join("\n")}
</urlset>`;

    fs.writeFileSync(
        path.join(DEST_PATH, "sitemap.xml"),
        sitemapXML
    );
    
const sitemapHTML=`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Index of /</title><meta name="robots" content="index,follow"><meta name="description" content="Browse all pages on the website."></head>
<style>li{margin: 5px;padding: 5px;border: 1px dotted #ddd;list-style: none;font-size:0.8rem;}ul{ padding: 5px; }li:before{content: "📎 "; }a{text-decoration: none;}.hidden { display: none; }</style>
<body>
    <h1>Index of /</h1>
    <label for="search">Search</label>
    <input type="search" name="search" id="search" />
    <ul id="urlList">
        ${urls.map(([u,t])=>`
        <li><a href="${u}" title="${t}">${t}</a></li>`).join("")}
    </ul>
</body><script>document.getElementById("search").addEventListener("input", (searchInput)=> {document.querySelectorAll("#urlList>li").forEach((li) => {if(li.textContent.toLowerCase().includes(searchInput.target.value.toLowerCase())){li.classList.remove("hidden");} else {li.classList.add("hidden");}})})</script></html>`
    
    fs.writeFileSync(
        path.join(DEST_PATH, "sitemap.html"),
        sitemapHTML
    );
    
    console.log("✅ sitemap generated:", urls.length);
}
if(systemCommand == "sitemap"){
    generateSitemap();
}