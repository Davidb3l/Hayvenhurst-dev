//! Fixture for the Rust grouped-use expansion test. Every shape from
//! the extractor's spec is exercised here; the test asserts the right
//! number and content of expanded import edges.

use std::io;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, atomic::AtomicUsize};
use std::path::{self, PathBuf};
use std::fs as filesystem;
use std::env::*;
use std::process::{Command, Stdio, exit};

pub fn placeholder() {}
