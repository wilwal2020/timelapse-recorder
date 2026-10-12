"use strict";
/*
 * Small Photoshop helpers: document lookup, batchPlay with error checking,
 * and the recording ID stored in each document's XMP metadata (so a
 * recording picks up where it left off when the file is reopened, even if
 * it was renamed or moved).
 */

const { app, action, core } = require("photoshop");

const NS = "http://ns.timelapse-recorder.local/1.0/";

// batchPlay reports Photoshop errors as result descriptors instead of throwing.
async function bp(commands) {
  const res = await action.batchPlay(commands, {});
  for (const r of res || []) {
    if (r && r._obj === "error") throw new Error(r.message || "Photoshop command failed");
  }
  return res;
}

function openDocs() {
  const out = [];
  const docs = app.documents;
  for (let i = 0; i < docs.length; i++) out.push(docs[i]);
  return out;
}

function findDoc(id) {
  const docs = app.documents;
  for (let i = 0; i < docs.length; i++) if (docs[i].id === id) return docs[i];
  return null;
}

function activeDoc() {
  try { return app.documents.length ? app.activeDocument : null; } catch (e) { return null; }
}

function docName(doc) {
  try { return doc.name || doc.title || "Untitled"; } catch (e) { return "Untitled"; }
}

function docPath(doc) {
  try { return doc.path || ""; } catch (e) { return ""; }
}

/* ---------------- all layers in one call ---------------- */
// Walking doc.layers asks Photoshop once per property per layer, and each
// question waits for Photoshop's main thread: in a document with many layers
// that adds up after every stroke. This asks once for every layer.
// Returns the layers in panel order (top first) as
//   { id, name, visible, parent }   parent: index of the group it's in, or -1
// or null when Photoshop doesn't answer the way we expect (the caller then
// walks the DOM).
let multiGetFailures = 0, multiGetWorked = false;

function layerList(doc) {
  if (!multiGetWorked && multiGetFailures >= 5) return null;   // this Photoshop doesn't do it: stop asking
  const out = [];
  try {
    const r = action.batchPlay([
      {
        _obj: "multiGet",
        _target: { _ref: [{ _ref: "document", _id: doc.id }] },
        extendedReference: [["layerID", "name", "visible", "layerSection"], { _obj: "layer", index: 1, count: -1 }],
        options: { failOnMissingProperty: false, failOnMissingElement: false }
      },
      { _obj: "get", _target: [{ _property: "hasBackgroundLayer" }, { _ref: "document", _id: doc.id }] }
    ], { synchronousExecution: true });
    const list = r && r[0] && Array.isArray(r[0].list) ? r[0].list : null;
    if (!list) throw new Error("no layer list");
    const groups = [];                               // indexes (in `out`) of the groups we're inside
    for (let i = list.length - 1; i >= 0; i--) {     // the list runs from the bottom layer up
      const l = list[i];
      const section = l.layerSection && l.layerSection._value;
      if (section === "layerSectionEnd") {           // the hidden marker below a group's contents
        if (!groups.length) throw new Error("unexpected group end");
        groups.pop();
        continue;
      }
      if (typeof l.layerID !== "number" || typeof l.visible !== "boolean") throw new Error("unexpected layer entry");
      out.push({ id: l.layerID, name: String(l.name || ""), visible: l.visible, parent: groups.length ? groups[groups.length - 1] : -1 });
      if (section === "layerSectionStart") groups.push(out.length - 1);
    }
    if (groups.length) throw new Error("unclosed group");
    // the Background layer isn't part of that list when the document has one
    if (r[1] && r[1].hasBackgroundLayer) {
      const bg = doc.backgroundLayer;
      if (bg && !out.some((l) => l.id === bg.id)) out.push({ id: bg.id, name: String(bg.name || ""), visible: !!bg.visible, parent: -1 });
    }
  } catch (e) {
    multiGetFailures++;
    return null;
  }
  multiGetWorked = true;
  return out;
}

// The same list by walking the DOM (slower: several calls per layer). Names
// are only read when asked for.
function layerListDom(doc) {
  const out = [];
  const walk = (layers, parent) => {
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      let item;
      try {
        let name = null;
        item = {
          id: l.id, visible: !!l.visible, parent,
          get name() { if (name === null) { try { name = String(l.name || ""); } catch (e) { name = ""; } } return name; }
        };
      } catch (e) { continue; }                       // layer gone
      out.push(item);
      let kids = null;
      try { kids = l.layers; } catch (e) { kids = null; }
      if (kids && kids.length) walk(kids, out.length - 1);
    }
  };
  try { walk(doc.layers, -1); } catch (e) { /* no layers */ }
  return out;
}

function layers(doc) { return layerList(doc) || layerListDom(doc); }

// Shows (visible = true) or hides layers by id, in one batchPlay call. Needs
// a modal scope. Layers that can't be switched are skipped.
async function setVisible(docId, ids, visible) {
  if (!ids.length) return;
  try {
    await action.batchPlay(ids.map((id) => ({
      _obj: visible ? "show" : "hide",
      null: [{ _ref: "layer", _id: id }, { _ref: "document", _id: docId }]
    })), { dialogOptions: "dontDisplay" });
  } catch (e) { /* a layer was deleted meanwhile */ }
}

/* ---------------- recording ID in XMP ---------------- */

async function readXmp(docId) {
  try {
    const r = await action.batchPlay([{
      _obj: "get",
      _target: [{ _property: "XMPMetadataAsUTF8" }, { _ref: "document", _id: docId }]
    }], {});
    return (r && r[0] && typeof r[0].XMPMetadataAsUTF8 === "string") ? r[0].XMPMetadataAsUTF8 : "";
  } catch (e) {
    return "";
  }
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"); }

// The toolkit may re-serialise our property as an attribute or an element,
// and may bind the namespace to another prefix, so look it up by URI.
function extractId(xmp) {
  if (!xmp) return null;
  const pm = xmp.match(new RegExp("xmlns:([A-Za-z_][\\w.-]*)\\s*=\\s*[\"']" + escapeRe(NS) + "[\"']"));
  if (!pm) return null;
  const p = escapeRe(pm[1]);
  const m = xmp.match(new RegExp(p + ":RecordingID\\s*=\\s*[\"']([^\"']+)[\"']")) ||
            xmp.match(new RegExp("<" + p + ":RecordingID>([^<]+)</" + p + ":RecordingID>"));
  return m ? m[1].trim() : null;
}

function injectId(xmp, id) {
  const desc = '<rdf:Description rdf:about="" xmlns:tlr="' + NS + '" tlr:RecordingID="' + id + '"/>';
  if (!xmp || xmp.indexOf("</rdf:RDF>") < 0) {
    return '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      desc + '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  }
  const pm = xmp.match(new RegExp("xmlns:([A-Za-z_][\\w.-]*)\\s*=\\s*[\"']" + escapeRe(NS) + "[\"']"));
  if (pm) {
    const p = escapeRe(pm[1]);
    const attr = new RegExp("(" + p + ":RecordingID\\s*=\\s*[\"'])[^\"']*([\"'])");
    const elem = new RegExp("(<" + p + ":RecordingID>)[^<]*(</" + p + ":RecordingID>)");
    if (attr.test(xmp)) return xmp.replace(attr, "$1" + id + "$2");
    if (elem.test(xmp)) return xmp.replace(elem, "$1" + id + "$2");
  }
  return xmp.replace("</rdf:RDF>", desc + "</rdf:RDF>");
}

async function writeId(docId, id) {
  const xmp = injectId(await readXmp(docId), id);
  await core.executeAsModal(async () => {
    await bp([{
      _obj: "set",
      _target: [{ _ref: "property", _property: "XMPMetadataAsUTF8" }, { _ref: "document", _id: docId }],
      to: { _obj: "document", XMPMetadataAsUTF8: xmp }
    }]);
  }, { commandName: "Link timelapse recording", timeOut: 5000 });
}

async function readId(docId) {
  return extractId(await readXmp(docId));
}

module.exports = { bp, openDocs, findDoc, activeDoc, docName, docPath, readId, writeId, extractId, injectId, layers, layerList, layerListDom, setVisible };
