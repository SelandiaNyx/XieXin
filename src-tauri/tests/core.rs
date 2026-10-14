// Exercise the persistence and export code without linking the desktop event loop.
#![allow(dead_code)]
#[path = "../src/cover.rs"] mod cover;
#[path = "../src/storage/mod.rs"] mod storage;
#[path = "../src/text.rs"] mod text;
#[path = "../src/dialog.rs"] mod dialog;
#[path = "../src/epub.rs"] mod epub;
#[path = "../src/export.rs"] mod export;
#[path = "../src/zip.rs"] mod zip;
