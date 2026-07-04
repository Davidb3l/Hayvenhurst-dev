//! Per-file extraction: turn one source file into a stream of `Node` and
//! `Edge` records.
//!
//! The extractor is intentionally simple and conservative. It does NOT
//! attempt name resolution, type inference, or call target resolution —
//! the daemon owns that, with the help of its full project index. What
//! we produce here is the local, file-bounded view: every definition
//! and every textual call/import target as written in source.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use tree_sitter::{Node, Parser, Query, QueryCursor, StreamingIterator, Tree};

use super::hash::hash_span;
use super::language::Language;
use super::signature::extract_signature;
use crate::proto::{ImportAlias, Record};

/// Compute the synthetic module name for a file. Used as the `src_name`
/// of every file-level import edge so the daemon can resolve them
/// against the module node we emit at the top of each file's record
/// stream.
///
/// - Regular file: the file stem (filename without extension).
/// - `__init__.py`: the parent directory name (Python package).
/// - `mod.rs` / `lib.rs` / `main.rs`: the parent directory name
///   (idiomatic Rust module roots).
///
/// `rel_path` is the forward-slash-separated path relative to the parse
/// root. If we somehow can't derive a name (e.g. weird path with no
/// stem) we fall back to the full `rel_path` so the value is at least
/// stable and unique per file.
pub fn module_name_for(rel_path: &str) -> String {
    let path = Path::new(rel_path);
    let filename = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");

    let use_parent = matches!(filename, "__init__.py" | "mod.rs" | "lib.rs" | "main.rs");

    if use_parent {
        if let Some(parent) = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
        {
            if !parent.is_empty() {
                return parent.to_string();
            }
        }
    }

    if !stem.is_empty() {
        stem.to_string()
    } else {
        rel_path.to_string()
    }
}

/// Tree-sitter query sources, compiled in via `include_str!`. Each
/// language file lives next to this module.
mod q {
    pub const PYTHON: &str = include_str!("queries/python.scm");
    pub const TYPESCRIPT: &str = include_str!("queries/typescript.scm");
    pub const JAVASCRIPT: &str = include_str!("queries/javascript.scm");
    pub const RUST: &str = include_str!("queries/rust.scm");
    pub const GO: &str = include_str!("queries/go.scm");
}

/// The result of extracting one file. Returned as a single batch so the
/// writer task can stream the records in order under one lock acquire.
pub struct FileExtraction {
    pub records: Vec<Record>,
}

/// Parse the contents of one file and produce the matching `Record`
/// batch. Errors here are *parse-fatal* for the file (couldn't even
/// load the grammar); the caller turns them into a `Warn` record and
/// moves on.
pub fn extract_file(rel_path: &str, source: &[u8], language: Language) -> Result<FileExtraction> {
    extract_file_opts(rel_path, source, language, false)
}

/// Like {@link extract_file} but with the `emit_signatures` opt-in (`parse
/// --signatures`). When `true`, a `Record::Signature` is emitted immediately
/// after each definition's `Record::Node`, carrying the real AST contract. The
/// Node/Edge/Warn output is identical in both modes — signatures are strictly
/// additive interleaved lines.
pub fn extract_file_opts(
    rel_path: &str,
    source: &[u8],
    language: Language,
    emit_signatures: bool,
) -> Result<FileExtraction> {
    let ts_lang = language.tree_sitter_language();

    // For `.astro` we parse ONLY the `---…---` frontmatter (TypeScript) using
    // the TS grammar. `parse_source` is the slice tree-sitter sees; `line_offset`
    // is the count of file lines preceding the frontmatter content, added back to
    // every node line range so ranges map to the real file. `module_source` is
    // always the WHOLE file (the module node + ast_hash represent the file, not
    // just the frontmatter). For every other language all three coincide.
    let (parse_source, line_offset): (&[u8], usize) = if language == Language::Astro {
        match astro_frontmatter(source) {
            Some((slice, offset)) => (slice, offset),
            // No frontmatter (or unterminated): nothing of value to index, but
            // we still emit the module node below so the page is at least a
            // navigable entity. Parse an empty slice so the symbol loop is a
            // no-op without special-casing it.
            None => (b"", 0),
        }
    } else {
        (source, 0)
    };
    let module_source = source;

    let mut parser = Parser::new();
    parser
        .set_language(&ts_lang)
        .with_context(|| format!("set_language({})", language.as_str()))?;

    let tree = parser
        .parse(parse_source, None)
        .ok_or_else(|| anyhow!("tree-sitter returned no tree"))?;

    // Detect a genuine syntax error. Tree-sitter is error-recovering: a
    // broken file still yields a (partial) tree, so the only signal that
    // the parse was not clean is `has_error()` on the root, which is true
    // when the tree contains any ERROR or MISSING node. We surface this as
    // a `Warn` for the file — the daemon's Layer B pre-merge verify gate
    // (§17.2) treats a per-file warn as a syntax-phase failure. Emitted
    // first so it leads the file's record stream.
    let syntax_error_line = if tree.root_node().has_error() {
        first_syntax_error(tree.root_node()).map(|n| n.start_position().row + 1 + line_offset)
    } else {
        None
    };

    let query_src = match language {
        Language::Python => q::PYTHON,
        // Astro reuses the TypeScript query against its TS frontmatter.
        Language::TypeScript | Language::Tsx | Language::Astro => q::TYPESCRIPT,
        Language::JavaScript => q::JAVASCRIPT,
        Language::Rust => q::RUST,
        Language::Go => q::GO,
    };
    let query = Query::new(&ts_lang, query_src)
        .with_context(|| format!("compile query for {}", language.as_str()))?;

    // Resolve capture indices once. The query has up to four capture
    // names; missing captures stay `None` and the matching arm is
    // skipped. This keeps the per-match hot loop a flat dispatch.
    let mut cap_def_function = None;
    let mut cap_def_method = None;
    let mut cap_def_class = None;
    let mut cap_def_arrow = None;
    let mut cap_def_pair = None;
    let mut cap_def_field = None;
    let mut cap_def_cjs_export = None;
    let mut cap_name = None;
    let mut cap_call = None;
    let mut cap_import = None;
    for (i, name) in query.capture_names().iter().enumerate() {
        let i = i as u32;
        match *name {
            "definition.function" => cap_def_function = Some(i),
            "definition.method" => cap_def_method = Some(i),
            "definition.class" => cap_def_class = Some(i),
            // JS/TS arrow / function-expression assigned to a const/let/var,
            // and object-literal method pairs. See queries/*.scm.
            "definition.arrow" => cap_def_arrow = Some(i),
            "definition.pair" => cap_def_pair = Some(i),
            // JS/TS class-field arrow/function-expression methods
            // (`class C { get = (k) => … }`). See queries/*.scm.
            "definition.field" => cap_def_field = Some(i),
            // CommonJS `exports.foo = function(){}` / `module.exports.foo = …`
            // export-assigned callables. See queries/*.scm.
            "definition.cjs_export" => cap_def_cjs_export = Some(i),
            "name.definition" => cap_name = Some(i),
            "call" => cap_call = Some(i),
            "import" => cap_import = Some(i),
            _ => {}
        }
    }

    let mut records = Vec::new();

    // A syntax-error warning leads the stream when the parse wasn't clean.
    if let Some(line) = syntax_error_line {
        records.push(Record::Warn {
            file: rel_path.to_string(),
            message: format!("syntax error: tree-sitter parse incomplete near line {line}"),
        });
    }

    // Emit the synthetic module node FIRST, before any other records
    // for this file. The daemon's edge resolver anchors file-level
    // import edges against this node (see the `src_name` logic below).
    //
    // We hash the entire file rather than just the line range so the
    // module's `ast_hash` actually changes when the file content
    // changes — line count alone is far too coarse a signal.
    let module_name = module_name_for(rel_path);
    let total_lines = total_line_count(module_source);
    records.push(Record::Node {
        file: rel_path.to_string(),
        name: module_name.clone(),
        kind: "module".to_string(),
        qualified_name: module_name.clone(),
        language: language.as_str().to_string(),
        range: [1, total_lines.max(1)],
        ast_hash: hash_span(module_source),
    });

    let mut definitions: Vec<DefinitionSpan> = Vec::new();

    // First pass: collect definitions only. We need them before we can
    // resolve which enclosing entity a call belongs to ("src_name" on
    // the edge record). Tree nodes index into `parse_source` (for Astro
    // that's the frontmatter slice, not the whole file).
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, tree.root_node(), parse_source);
    while let Some(m) = matches.next() {
        // Determine the definition kind for this match, if any.
        let (def_capture, kind_str) = if Some(m.pattern_index as u32).is_some() {
            // We dispatch on capture id rather than pattern index so
            // re-ordering query.scm doesn't break us.
            let mut found: Option<(u32, &'static str)> = None;
            for cap in m.captures.iter() {
                if Some(cap.index) == cap_def_function {
                    found = Some((cap.index, "function"));
                    break;
                } else if Some(cap.index) == cap_def_method {
                    found = Some((cap.index, "method"));
                    break;
                } else if Some(cap.index) == cap_def_class {
                    found = Some((cap.index, "class"));
                    break;
                } else if Some(cap.index) == cap_def_arrow {
                    // `const f = () => …` — a named callable, reported as a
                    // function. The captured node is the `variable_declarator`.
                    found = Some((cap.index, "function"));
                    break;
                } else if Some(cap.index) == cap_def_pair {
                    // `{ method: () => … }` inside a bound object literal —
                    // reported as a method. The captured node is the `pair`.
                    found = Some((cap.index, "method"));
                    break;
                } else if Some(cap.index) == cap_def_field {
                    // `class C { get = (k) => … }` — a class-field arrow/
                    // function-expression method. Reported as a method,
                    // qualified by the enclosing class exactly like a
                    // `method_definition` (`Context.get`). The captured node
                    // is the field definition (spans name + value, so calls
                    // inside the body attribute to this entity).
                    found = Some((cap.index, "method"));
                    break;
                } else if Some(cap.index) == cap_def_cjs_export {
                    // `exports.foo = function(){}` — a CommonJS export-assigned
                    // callable, reported as a function named by the export
                    // property. The captured node is the whole
                    // `assignment_expression` (spans the value body, so calls
                    // inside it attribute to this entity). Guarded below:
                    // only an `exports`/`module.exports` object qualifies.
                    found = Some((cap.index, "function"));
                    break;
                }
            }
            match found {
                Some((c, k)) => (c, k),
                None => continue,
            }
        } else {
            continue;
        };

        // Find the corresponding name node within the same match.
        let def_node = m
            .captures
            .iter()
            .find(|c| c.index == def_capture)
            .map(|c| c.node);
        let name_node = m
            .captures
            .iter()
            .find(|c| Some(c.index) == cap_name)
            .map(|c| c.node);

        let (Some(def_node), Some(name_node)) = (def_node, name_node) else {
            continue;
        };
        let Ok(name) = name_node.utf8_text(parse_source) else {
            continue;
        };

        // A `definition.pair` is promoted to an entity when either:
        //   (1) its object literal is bound to a name (`const api = { … }`) —
        //       the `api.search` surface agents search for; OR
        //   (2) it is a CALLABLE-valued pair (`resolve: async () => {…}`) inside
        //       an anonymous object passed to a builder call
        //       (`builder.mutationField('addComment', (t) => t.field({ resolve:
        //       async () => {…} }))`). These resolver functions are REAL bodies
        //       agents search for and the natural `src` of the calls inside them
        //       — without promoting them, every call in such a body collapses to
        //       the module node (all callers in a file become one edge). We
        //       qualify it by the nearest enclosing builder-field name (the
        //       string-literal first arg) so the id is stable + distinct.
        // A plain-value config pair (`limit: 20`, `nullable: true`) in an unbound
        // object is still skipped — that's the one-off option-bag noise we avoid.
        let is_arrow = Some(def_capture) == cap_def_arrow;
        let is_pair = Some(def_capture) == cap_def_pair;
        // A class-field arrow (`class C { get = (k) => … }`). Follows the
        // `method_definition` path for kind + qualified name (class-method
        // convention: `Context.get`, `C.#handler`) but, like arrow/pair, its
        // callable contract lives on the `value` node.
        let is_field = Some(def_capture) == cap_def_field;
        // A CommonJS export-assigned callable (`exports.foo = fn`,
        // `module.exports.foo = fn`). The query matches ANY
        // `<member>.<prop> = <callable>` assignment; only the two exports
        // objects are promoted — an arbitrary `obj.foo = fn` mutation
        // (prototype patching, test monkey-patching) is NOT a module export
        // and indexing it would pollute name resolution across the package.
        let is_cjs_export = Some(def_capture) == cap_def_cjs_export;
        if is_cjs_export && !cjs_export_target(def_node, parse_source) {
            continue;
        }
        if is_pair {
            let bound = bound_object_name(def_node, parse_source).is_some();
            // A callable pair in an UNBOUND object is promoted ONLY when it sits
            // inside a member-call builder chain (`builder.field(...)`,
            // `t.field(...)`) that gives it a stable qualifier — i.e. a real
            // resolver/handler. A callable pair in a one-off BARE call
            // (`register({ onClick: () => … })`, identifier callee, no
            // qualifier) is still skipped: that's anonymous event-handler config,
            // not a searchable entity. This keeps the index from exploding on
            // arbitrary inline callbacks while capturing framework resolvers.
            let builder_resolver = pair_value_is_callable(def_node)
                && enclosing_builder_field_name(def_node, parse_source).is_some();
            if !bound && !builder_resolver {
                continue;
            }
        }

        let kind = resolve_kind(kind_str, language, def_node);
        let qualified = if is_arrow || is_pair {
            arrow_qualified_name(name, def_node, is_pair, parse_source)
        } else {
            qualified_name(name, language, &tree, def_node, parse_source)
        };

        // For arrow/pair/class-field captures the node carrying the callable
        // contract is the `value` (the `arrow_function`/`function_expression`),
        // not the declarator/pair/field wrapper — for a CJS export assignment
        // it's the `right`. The signature extractor needs that inner node to
        // find the `parameters`/`return_type` fields.
        let sig_node = if is_arrow || is_pair || is_field {
            def_node.child_by_field_name("value").unwrap_or(def_node)
        } else if is_cjs_export {
            def_node.child_by_field_name("right").unwrap_or(def_node)
        } else {
            def_node
        };

        definitions.push(DefinitionSpan {
            name: name.to_string(),
            qualified_name: qualified.clone(),
            kind: kind.to_string(),
            start_byte: def_node.start_byte(),
            end_byte: def_node.end_byte(),
            start_line: def_node.start_position().row + 1,
            end_line: def_node.end_position().row + 1,
        });

        records.push(Record::Node {
            file: rel_path.to_string(),
            name: name.to_string(),
            kind: kind.to_string(),
            qualified_name: qualified.clone(),
            language: language.as_str().to_string(),
            // `line_offset` maps frontmatter-relative rows back to the real
            // `.astro` file. It is 0 for every other language.
            range: [
                def_node.start_position().row + 1 + line_offset,
                def_node.end_position().row + 1 + line_offset,
            ],
            ast_hash: hash_span(&parse_source[def_node.start_byte()..def_node.end_byte()]),
        });

        // OPT-IN: the real tree-sitter contract signature for this definition,
        // emitted right after its Node so a reader can join them positionally.
        // Strictly additive — absent unless `parse --signatures` is set.
        if emit_signatures {
            if let Some(sig) = extract_signature(sig_node, name, language, parse_source) {
                records.push(Record::Signature {
                    file: rel_path.to_string(),
                    name: name.to_string(),
                    qualified_name: qualified,
                    kind: kind.to_string(),
                    language: language.as_str().to_string(),
                    arity: sig.arity,
                    params: sig.params,
                    return_type: sig.return_type,
                    visibility: sig.visibility.as_str().to_string(),
                });
            }
        }
    }

    // Sort definitions by start byte so the enclosing-definition lookup
    // can pick the innermost containing span by linear scan.
    definitions.sort_by_key(|d| (d.start_byte, std::cmp::Reverse(d.end_byte)));

    // Rust `impl … { … }` blocks are NOT captured by the query — only the
    // methods inside them are (promoted to `Type::method`). So the block's
    // `impl …{` opener and its closing `}` belong to no entity range, and the
    // context packer's module-skeleton header pass (`moduleScopeSegments`,
    // which builds the header by subtracting entity BODIES) leaks them as tiny
    // junk fragments. Emit one coverage Node per impl block spanning the whole
    // `[start,end]` so the packer treats the wrapper as an entity and absorbs
    // it. (Trait blocks already get a full-span node via `trait_item`.)
    if language == Language::Rust {
        collect_rust_impl_nodes(tree.root_node(), parse_source, rel_path, &mut records);
    }

    // Second pass: calls and imports. We re-run the cursor because
    // QueryCursor::matches consumes its borrow of the tree.
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, tree.root_node(), parse_source);
    while let Some(m) = matches.next() {
        for cap in m.captures.iter() {
            if Some(cap.index) == cap_call {
                // CommonJS `require("<string literal>")` is an IMPORT, not a
                // call (JS-family grammars only). The `(call_expression) @call`
                // capture already matches every require call, so we intercept
                // here rather than adding a query pattern: emit an `import`
                // edge carrying the string-literal specifier as `dst_name`
                // (exactly the ESM wire shape, resolved by the daemon's
                // SpecifierResolver) plus the `local` binding name(s) /
                // `import_aliases` derived from the binding form around the
                // call, so destructured/assigned require bindings feed
                // member-call resolution the same way ESM imports do.
                //
                // The edge REPLACES the legacy unresolved `?:require`
                // static_call (one source construct, one edge) — mirroring how
                // an ESM `import` statement never doubles as a call. A
                // dynamic/computed `require(expr)` does NOT match
                // `require_specifier` and stays an unresolved CALL, unchanged.
                if is_js_family(language) {
                    if let Some(spec) = require_specifier(&cap.node, parse_source) {
                        let src_name = enclosing_definition(&definitions, cap.node.start_byte())
                            .map(|d| d.qualified_name.clone())
                            .unwrap_or_else(|| module_name.clone());
                        let (local, import_aliases) = require_bindings(&cap.node, parse_source);
                        records.push(Record::Edge {
                            src_file: rel_path.to_string(),
                            src_name,
                            dst_name: spec,
                            kind: "import".to_string(),
                            receiver: None,
                            receiver_chain: None,
                            local,
                            import_aliases,
                            // Import edges carry no call-site position (matches
                            // the ESM import-edge wire contract).
                            line: None,
                            col: None,
                        });
                        continue;
                    }
                }
                if let Some(target) = call_target_name(&cap.node, parse_source) {
                    let src_name = enclosing_definition(&definitions, cap.node.start_byte())
                        .map(|d| d.qualified_name.clone())
                        .unwrap_or_else(|| rel_path.to_string());
                    // Member-access call `recv.method(...)`: emit the receiver
                    // identifier so the daemon can resolve the method against
                    // whatever `recv` binds to (e.g. an imported `local` name).
                    // Bare-identifier calls `foo()` carry no receiver.
                    let receiver = call_receiver_name(&cap.node, parse_source);
                    // For a MULTI-segment chain (`api.client.search()`), also
                    // emit the full root→immediate-object segment list so the
                    // daemon can bind the chain ROOT to an import and walk the
                    // intermediate segments. `None` for single-segment receivers
                    // (`api.search()`) so the common-case wire stays byte-identical.
                    //
                    // DYNAMIC/COMPUTED DISPATCH (`arr[i]()`, `getThing().run()`)
                    // is intentionally left UNRESOLVED: the called expression has
                    // no statically-knowable target without full type inference
                    // / data-flow (which the extractor deliberately does not do —
                    // see the module header). Such calls have a non-nameable root
                    // (subscript / call / paren), so both `call_receiver_name` and
                    // `call_receiver_chain` return `None`, the edge carries no
                    // receiver, and the daemon leaves it `?:<callee>` rather than
                    // inventing a false edge. This is the CORRECT outcome, not a
                    // bug — emitting a guess here would pollute the call graph.
                    let receiver_chain = call_receiver_chain(&cap.node, parse_source);
                    // Line-precise call SITE: the START of `cap.node` — the same
                    // call/callee capture node `dst_name` was derived from (one
                    // edge record == one call occurrence, this is its position).
                    // `+ line_offset` maps Astro frontmatter-relative rows back to
                    // the real file, matching the Node-range convention above.
                    let site = cap.node.start_position();
                    records.push(Record::Edge {
                        src_file: rel_path.to_string(),
                        src_name,
                        dst_name: target,
                        kind: "static_call".to_string(),
                        receiver,
                        receiver_chain,
                        local: None,
                        import_aliases: None,
                        line: Some(site.row + 1 + line_offset),
                        col: Some(site.column + 1),
                    });
                }
            } else if Some(cap.index) == cap_import {
                // An import nested inside a function/method (Python's
                // local `import`, TS dynamic `import()` inside a body)
                // should point from the enclosing definition. A
                // module-scope import points from the synthetic module
                // node we emitted at the top of the file.
                let src_name = enclosing_definition(&definitions, cap.node.start_byte())
                    .map(|d| d.qualified_name.clone())
                    .unwrap_or_else(|| module_name.clone());
                // Local binding name(s) this import introduces into scope.
                // `None` (no `local` field) for side-effect imports and for
                // languages we don't extract bindings for yet (priority is
                // TS/JS/TSX/Astro). Computed once per statement and shared by
                // every dst this statement emits.
                let local = import_local_bindings(&cap.node, language, parse_source);
                // Aliased named bindings (`import { a as b }`): carry the
                // {local, imported} pairs so the daemon can map a call to the
                // local alias back to the real exported symbol. `None` (omitted
                // from the wire) when this import introduces no aliases, so the
                // common case stays byte-identical. Shared by every dst this
                // statement emits, like `local`.
                let import_aliases = import_alias_pairs(&cap.node, language, parse_source);
                for target in import_targets(&cap.node, language, parse_source) {
                    records.push(Record::Edge {
                        src_file: rel_path.to_string(),
                        src_name: src_name.clone(),
                        dst_name: target,
                        kind: "import".to_string(),
                        receiver: None,
                        receiver_chain: None,
                        local: local.clone(),
                        import_aliases: import_aliases.clone(),
                        // Import edges carry no call-site position.
                        line: None,
                        col: None,
                    });
                }
            }
        }
    }

    // Astro: the markup BELOW the `---` frontmatter fence is not in `parse_source`
    // (it's HTML-ish, a different grammar). Component USAGE in that markup
    // (`<Stats/>`, `<Foo.Bar/>`) is a real dependency on the frontmatter import
    // that introduced the component — emit a `static_call` edge per usage so the
    // daemon's Tier-2 resolver can bind it to that import's `local`. We scan the
    // template body textually (capitalized/dotted JSX-element open tags); the
    // edge's `receiver`/`receiver_chain` carry the component path so resolution
    // reuses the exact member-call machinery. Module-scope (the template runs at
    // module level), so `src_name` is the module node.
    if language == Language::Astro {
        for comp in astro_template_components(module_source) {
            // `<Stats/>` → root=dst="Stats" (binds to import, resolves to module).
            // `<Foo.Bar/>` → root "Foo", member "Bar" (resolves a member of the
            // imported module, via the receiver/chain path).
            //
            // The `receiver_chain` EXCLUDES the trailing member, mirroring
            // `call_receiver_chain` exactly (`api.client.search()` → receiver
            // `api`, chain `["api","client"]`, dst `search`; `api.search()` →
            // receiver `api`, chain `None`, dst `search`). So:
            //   `<Foo.Bar/>`     → receiver `Foo`, chain `None`,           dst `Bar`
            //   `<Foo.Bar.Baz/>` → receiver `Foo`, chain `["Foo","Bar"]`,  dst `Baz`
            // Including the tail (the old bug) made the daemon's resolver build
            // a duplicated-tail candidate (`<mod>/Bar/Baz/Baz`) that never
            // matched; a single-segment chain collapses to `None` so the common
            // 2-part `<Foo.Bar/>` case carries only the immediate-object
            // `receiver`, just like a single-segment member call.
            let (receiver, receiver_chain, dst_name) = match comp.as_slice() {
                [single] => (single.clone(), None, single.clone()),
                [root, .., last] => {
                    let chain: Vec<String> = comp[..comp.len() - 1].to_vec();
                    let chain = if chain.len() < 2 { None } else { Some(chain) };
                    (root.clone(), chain, last.clone())
                }
                [] => continue,
            };
            records.push(Record::Edge {
                src_file: rel_path.to_string(),
                src_name: module_name.clone(),
                dst_name,
                kind: "static_call".to_string(),
                receiver: Some(receiver),
                receiver_chain,
                local: None,
                import_aliases: None,
                // Astro template-component usages are found by a textual scan of
                // the markup body (not a tree-sitter node), so no precise call
                // site is known — leave line/col as `None`.
                line: None,
                col: None,
            });
        }
    }

    Ok(FileExtraction { records })
}

/// Scan an `.astro` file's TEMPLATE body (the markup after the closing `---`
/// fence) for component-element usages and return each as a dotted path split
/// into segments: `<Stats/>` → `["Stats"]`, `<Foo.Bar/>` → `["Foo","Bar"]`.
///
/// HEURISTIC (and its limits). This is a deliberately lightweight TEXTUAL scan,
/// not a full HTML/JSX parse — the Astro template grammar isn't loaded
/// (TREE_SITTER_NOTES.md "Astro"). A `<` only starts a component edge when it
/// looks like a real element open tag, which we approximate with three guards
/// that together reject the common false positives (`a < B`, `List<String>`):
///
/// 1. The char immediately after `<` begins a component name: an uppercase
///    ASCII letter `[A-Z]` (the JSX/Astro component convention). Lowercase HTML
///    tags (`<div>`, `<p>`) are NOT components and are skipped. A leading `.` or
///    digit is not a name.
/// 2. The char immediately BEFORE `<` is not an identifier char / `)` / `]`.
///    Those indicate a comparison or a generic (`count<Threshold`, `foo()<x`,
///    `arr[i]<n`), where `<` is an operator, not a tag opener. A real tag's `<`
///    follows whitespace, another `>`, `{`, `(`, `,`, a quote, etc. (or starts
///    the body).
/// 3. The tag NAME (incl. dotted members) is followed by a valid tag
///    terminator: ASCII whitespace, `/`, or `>`. `List<String>` reads `List`
///    then `<` — not a terminator after the name we'd capture — so it never
///    matches; and even when the `<` clears guard 2 it can't both follow an
///    identifier and start a name.
///
/// We do NOT scan inside `{…}` JSX expression blocks (`{count<Threshold?…}`,
/// `{items.map(…)}`) — component tags there are real but the cost of teasing
/// real tags out of arbitrary expression text isn't worth the false positives,
/// so the block is skipped wholesale. We also skip `<script>`/`<style>` region
/// contents (their bodies are JS/CSS, where `<` is an operator) and `<!-- … -->`
/// HTML comments (a component name in a comment is not a usage). The
/// frontmatter region is excluded entirely (we only scan after the closing
/// fence).
///
/// Accepted residual (rare, pre-existing): a bare comparison in RAW template
/// text with a space before an uppercase operand (`a <B && c`) is textually
/// indistinguishable from a legitimate `text <Comp/>` element (both are
/// `<` + uppercase after whitespace), so it can still yield a spurious edge.
/// In real `.astro` text a literal `<` should be escaped (`&lt;`), so this is
/// uncommon; resolving it would require full template parsing.
///
/// Kept correct: lowercase HTML tags are never edges; `<Foo.Bar/>` dotted
/// components ARE edges; each open tag is counted once (self-closing `<Stats/>`
/// and paired `<Base>…</Base>` both yield one usage; `</Base>` close tags and
/// duplicate usages dedupe to a single edge).
fn astro_template_components(source: &[u8]) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Locate the byte just past the closing `---` fence; scan only the template.
    let template_start = match astro_template_start(source) {
        Some(b) => b,
        None => return out,
    };

    let body = &source[template_start..];
    let n = body.len();
    let mut i = 0usize;
    while i < n {
        let c = body[i];
        // Skip `{…}` JSX expression blocks wholesale (nested braces tracked) —
        // `<` inside an expression is an operator/generic, not a tag opener.
        if c == b'{' {
            let mut depth = 1usize;
            i += 1;
            while i < n && depth > 0 {
                match body[i] {
                    b'{' => depth += 1,
                    b'}' => depth -= 1,
                    _ => {}
                }
                i += 1;
            }
            continue;
        }
        if c != b'<' {
            i += 1;
            continue;
        }
        let after = i + 1;
        if after >= n {
            break;
        }
        // `<script>`/`<style>`: skip to the matching close tag — their bodies
        // are JS/CSS where `<` is an operator. (Lowercase tag name match.)
        if let Some(skip_to) = skip_raw_text_element(body, i) {
            i = skip_to;
            continue;
        }
        // `<!-- … -->` HTML comment: skip its ENTIRE body to the matching `-->`.
        // A component name inside a comment (`<!-- <Stats/> -->`) is not a real
        // usage; the old `<!`-only skip kept scanning inside the comment and
        // emitted a phantom edge. Must run before the generic `<!`/`</` skip.
        if body[after..].starts_with(b"!--") {
            let mut k = after + 3; // past `!--`
            let mut end = n;
            while k + 3 <= n {
                if &body[k..k + 3] == b"-->" {
                    end = k + 3;
                    break;
                }
                k += 1;
            }
            i = end; // unterminated comment → skip to EOF (safe)
            continue;
        }
        // Skip a close tag `</…>` or processing/doctype `<!…>`.
        if body[after] == b'/' || body[after] == b'!' {
            i = after + 1;
            continue;
        }
        // Guard 1: the name must begin with an uppercase ASCII letter — the
        // JSX/Astro component convention. Lowercase HTML tags and `<.`/`<1`
        // are not components.
        if !body[after].is_ascii_uppercase() {
            i = after;
            continue;
        }
        // Guard 2: a real tag's `<` is NOT immediately preceded by an
        // identifier char / `)` / `]` — those mean a comparison/generic
        // (`count<Threshold`, `foo()<B`, `arr[i]<B`), where `<` is an operator.
        if i > 0 {
            let prev = body[i - 1];
            if prev.is_ascii_alphanumeric() || prev == b'_' || prev == b'$' || prev == b')'
                || prev == b']'
            {
                i = after;
                continue;
            }
        }
        // Read the tag name: ASCII letters/digits/`.`/`_`/`$`.
        let name_start = after;
        let mut j = name_start;
        while j < n {
            let ch = body[j];
            if ch.is_ascii_alphanumeric() || ch == b'.' || ch == b'_' || ch == b'$' {
                j += 1;
            } else {
                break;
            }
        }
        // Guard 3: the name must be followed by a valid tag terminator
        // (whitespace, `/`, `>`). Otherwise this is a generic/comparison like
        // `List<String>` (the `<` after `List` is not a terminator) — reject.
        let terminated = match body.get(j) {
            Some(t) => t.is_ascii_whitespace() || *t == b'/' || *t == b'>',
            None => false, // EOF mid-name → not a real open tag.
        };
        if terminated {
            let raw = &body[name_start..j];
            // A trailing dot (`<Foo.`) leaves an empty tail segment; the filter
            // below drops it, and a leading dot was already excluded by guard 1.
            if let Ok(name) = std::str::from_utf8(raw) {
                let segments: Vec<String> = name
                    .split('.')
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect();
                // Dedupe on the canonical dotted key so `<Foo.Bar/>` and a
                // dangling `<Foo.Bar.>` don't both fire.
                let key = segments.join(".");
                if !segments.is_empty() && seen.insert(key) {
                    out.push(segments);
                }
            }
        }
        i = j.max(after);
    }
    out
}

/// If `body[at]` opens a raw-text element (`<script>` or `<style>`, any case,
/// regardless of attributes), return the byte offset just past its matching
/// close tag (`</script>` / `</style>`) so the caller can skip the JS/CSS body
/// — where `<` is an operator, not a tag opener. Returns `None` when `at` does
/// not open such an element.
fn skip_raw_text_element(body: &[u8], at: usize) -> Option<usize> {
    let n = body.len();
    let rest = &body[at..];
    for (tag, close) in [
        (&b"<script"[..], &b"</script"[..]),
        (&b"<style"[..], &b"</style"[..]),
    ] {
        if rest.len() < tag.len() || !rest[..tag.len()].eq_ignore_ascii_case(tag) {
            continue;
        }
        // The open tag's name must end here (next char is `>`, whitespace, or
        // `/`) so `<scripting>` doesn't match `<script>`.
        let nxt = body.get(at + tag.len());
        let opens = matches!(nxt, Some(b'>') | Some(b'/') | None)
            || nxt.is_some_and(|c| c.is_ascii_whitespace());
        if !opens {
            continue;
        }
        // Find the matching close tag, case-insensitively.
        let mut k = at + tag.len();
        while k + close.len() <= n {
            if body[k..k + close.len()].eq_ignore_ascii_case(close) {
                // Advance past the close tag's `>` if present.
                let mut e = k + close.len();
                while e < n && body[e] != b'>' {
                    e += 1;
                }
                if e < n {
                    e += 1;
                }
                return Some(e);
            }
            k += 1;
        }
        // Unterminated raw-text element: skip to EOF (no tags can follow).
        return Some(n);
    }
    None
}

/// Byte offset of the start of an `.astro` file's template body (the byte just
/// after the newline that follows the CLOSING `---` fence), or `None` when the
/// file has no terminated frontmatter (then the whole file is template-ish, but
/// without a fence Astro treats it as markup — we still scan from byte 0).
fn astro_template_start(source: &[u8]) -> Option<usize> {
    let n = source.len();
    let mut line_start = 0usize;
    let mut open_fence = false;
    while line_start < n {
        let mut j = line_start;
        while j < n && source[j] != b'\n' {
            j += 1;
        }
        let trimmed = trim_ascii(&source[line_start..j]);
        let next_line_start = if j < n { j + 1 } else { n };
        if open_fence {
            if trimmed == b"---" {
                // Template begins after this closing fence line.
                return Some(next_line_start);
            }
        } else if trimmed == b"---" {
            open_fence = true;
        } else if !trimmed.is_empty() {
            // No frontmatter fence: the whole file is markup. Scan from the top.
            return Some(0);
        }
        line_start = next_line_start;
    }
    // Opening fence never closed (or empty file) → no template region.
    if open_fence {
        None
    } else {
        Some(0)
    }
}

/// Lightweight per-definition record kept around for the second
/// (call/import) pass. We don't keep a borrow into the tree because
/// `QueryCursor::matches` re-borrows it.
struct DefinitionSpan {
    #[allow(dead_code)]
    name: String,
    qualified_name: String,
    #[allow(dead_code)]
    kind: String,
    start_byte: usize,
    end_byte: usize,
    #[allow(dead_code)]
    start_line: usize,
    #[allow(dead_code)]
    end_line: usize,
}

/// Innermost definition span that contains `byte_offset`, if any.
/// Walk the tree for Rust `impl_item` blocks and emit one coverage `Record::Node`
/// per block (see the call site for why). The node is kind `"other"` — NOT
/// `"class"`/`"module"` — so it (a) is not skipped by the packer's
/// module-skeleton pass, (b) is never pulled in as a referenced TYPE by the
/// packer's `kind === "class"` ref gate, and (c) does not collide on a derived
/// id with the same-named `struct`/`enum`/`trait` node (those carry the bare
/// `Foo` qn; the impl node carries the distinct `impl Foo` / `impl Trait for
/// Foo` qn). The block is NOT added to `definitions`, so call-edge `src_name`
/// resolution (which already attributes a method's calls to the method) is
/// unchanged.
fn collect_rust_impl_nodes(
    root: Node,
    source: &[u8],
    rel_path: &str,
    records: &mut Vec<Record>,
) {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.kind() == "impl_item" {
            if let Some(name) = rust_impl_name(node, source) {
                records.push(Record::Node {
                    file: rel_path.to_string(),
                    name: name.clone(),
                    kind: "other".to_string(),
                    qualified_name: name,
                    language: Language::Rust.as_str().to_string(),
                    // Rust always parses the whole file (line_offset 0), so the
                    // raw node rows are the real file rows.
                    range: [node.start_position().row + 1, node.end_position().row + 1],
                    ast_hash: hash_span(&source[node.start_byte()..node.end_byte()]),
                });
            }
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            stack.push(child);
        }
    }
}

/// A stable, collision-free name for a Rust impl block: `impl Foo`, or
/// `impl Trait for Foo` when it implements a trait. The `impl ` prefix keeps it
/// distinct from the bare `Foo` qn of the type's own `struct`/`enum`/`trait`
/// node so their derived ids never collide. Generic params on the impl
/// (`impl<T> Foo<T>`) live in a separate child, not the `type:` field, so the
/// name stays `impl Foo<T>`. Whitespace is collapsed so a multi-line type never
/// puts a newline in the name. `None` if the block has no readable `type:`.
fn rust_impl_name(node: Node, source: &[u8]) -> Option<String> {
    let collapse = |n: Node| -> Option<String> {
        n.utf8_text(source)
            .ok()
            .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|s| !s.is_empty())
    };
    let type_text = node.child_by_field_name("type").and_then(collapse)?;
    match node.child_by_field_name("trait").and_then(collapse) {
        Some(tr) => Some(format!("impl {tr} for {type_text}")),
        None => Some(format!("impl {type_text}")),
    }
}

fn enclosing_definition(defs: &[DefinitionSpan], byte_offset: usize) -> Option<&DefinitionSpan> {
    defs.iter()
        .filter(|d| d.start_byte <= byte_offset && byte_offset < d.end_byte)
        .min_by_key(|d| d.end_byte - d.start_byte)
}

/// Coarsen the query-tagged `kind` based on language-specific context.
/// For Python `function_definition` nodes inside a `class_definition`
/// we want to report `method`; the query can't easily distinguish that
/// itself.
fn resolve_kind(query_kind: &'static str, language: Language, node: Node) -> &'static str {
    if query_kind != "function" {
        return query_kind;
    }
    match language {
        Language::Python if has_ancestor(node, "class_definition") => "method",
        Language::Rust if has_ancestor(node, "impl_item") || has_ancestor(node, "trait_item") => {
            "method"
        }
        _ => "function",
    }
}

/// Build the `qualified_name` for a definition. For nested entities
/// this prepends the enclosing class/impl name using the language's
/// natural separator.
fn qualified_name(
    bare: &str,
    language: Language,
    _tree: &Tree,
    node: Node,
    source: &[u8],
) -> String {
    let sep = language.qualified_separator();
    let mut parents: Vec<String> = Vec::new();

    let mut cur = node.parent();
    while let Some(p) = cur {
        match (language, p.kind()) {
            (Language::Python, "class_definition") => {
                if let Some(n) = p.child_by_field_name("name") {
                    if let Ok(t) = n.utf8_text(source) {
                        parents.push(t.to_string());
                    }
                }
            }
            (
                Language::JavaScript | Language::TypeScript | Language::Tsx | Language::Astro,
                "class_declaration",
            ) => {
                if let Some(n) = p.child_by_field_name("name") {
                    if let Ok(t) = n.utf8_text(source) {
                        parents.push(t.to_string());
                    }
                }
            }
            (Language::Rust, "impl_item") => {
                if let Some(n) = p.child_by_field_name("type") {
                    if let Ok(t) = n.utf8_text(source) {
                        parents.push(t.to_string());
                    }
                }
            }
            (Language::Rust, "trait_item") => {
                if let Some(n) = p.child_by_field_name("name") {
                    if let Ok(t) = n.utf8_text(source) {
                        parents.push(t.to_string());
                    }
                }
            }
            (Language::Go, "method_declaration") => {
                // Method declarations carry the receiver type alongside the
                // method name; the query already captures the bare name so
                // we don't double-up here.
            }
            _ => {}
        }
        cur = p.parent();
    }

    if parents.is_empty() {
        bare.to_string()
    } else {
        parents.reverse();
        let mut s = parents.join(sep);
        s.push_str(sep);
        s.push_str(bare);
        s
    }
}

/// For a `definition.pair` node (`key: value` inside an object literal),
/// return the name the *enclosing* object literal is bound to, if any. We only
/// promote a pair to an entity when its object is assigned to a `const`/`let`/
/// `var` (`const api = { … }`) or is the value of another bound pair — an
/// anonymous inline object (`foo({ onClick: () => … })`) returns `None` and is
/// skipped. We stop at the first enclosing `variable_declarator` or `pair`;
/// that's the object's binding.
fn bound_object_name(pair_node: Node, source: &[u8]) -> Option<String> {
    // pair → object → (variable_declarator | pair)
    let object = pair_node.parent()?;
    if object.kind() != "object" {
        return None;
    }
    let binder = object.parent()?;
    match binder.kind() {
        "variable_declarator" => binder
            .child_by_field_name("name")
            .and_then(|n| n.utf8_text(source).ok())
            .map(|s| s.to_string()),
        // A nested object literal that is itself a bound pair's value:
        // `const a = { b: { c: () => … } }` → the `c` method belongs to `a/b`.
        "pair" => binder
            .child_by_field_name("key")
            .and_then(|n| n.utf8_text(source).ok())
            .map(|s| s.to_string()),
        _ => None,
    }
}

/// True when a `pair` node's value is a callable body (an arrow function or a
/// function expression) — i.e. a resolver/handler, not a plain-value config
/// entry. Used to promote `{ resolve: async () => {…} }` inside an unbound
/// object while still skipping `{ nullable: true }`-style option bags.
fn pair_value_is_callable(pair_node: Node) -> bool {
    matches!(
        pair_node
            .child_by_field_name("value")
            .map(|v| v.kind()),
        Some("arrow_function") | Some("function_expression")
    )
}

/// For a callable `pair` inside an UNBOUND object (`builder.field('name', (t) =>
/// t.field({ resolve: () => … }))`), find a stable qualifier from the nearest
/// enclosing builder call: the FIRST string-literal argument of a
/// `call_expression` whose callee is a member access (`builder.mutationField`,
/// `t.field` …). Returns e.g. `"addComment"` for
/// `builder.mutationField('addComment', …)`. Falls back to the member property
/// name (`field`) when the call has no string arg, and `None` if no enclosing
/// member call is found. This makes each anonymous resolver a distinct,
/// human-meaningful entity instead of collapsing to the module.
fn enclosing_builder_field_name(pair_node: Node, source: &[u8]) -> Option<String> {
    // Walk the WHOLE ancestor chain and prefer the FIRST string-literal arg of
    // ANY enclosing builder call — that's the GraphQL field name
    // (`builder.mutationField('addComment', (t) => t.field({ resolve … }))`):
    // the inner `t.field(...)` has no name, so we must keep climbing to
    // `mutationField('addComment', …)`. Only if no enclosing call carries a
    // string name do we fall back to the innermost call's member property.
    let mut fallback: Option<String> = None;
    let mut cur = pair_node.parent();
    while let Some(p) = cur {
        if p.kind() == "call_expression" {
            if let Some(args) = p.child_by_field_name("arguments") {
                let mut c = args.walk();
                for arg in args.named_children(&mut c) {
                    if arg.kind() == "string" {
                        let mut sc = arg.walk();
                        for frag in arg.named_children(&mut sc) {
                            if frag.kind() == "string_fragment" {
                                if let Ok(t) = frag.utf8_text(source) {
                                    if !t.is_empty() {
                                        return Some(t.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if fallback.is_none() {
                if let Some(callee) = p.child_by_field_name("function") {
                    if callee.kind() == "member_expression" {
                        if let Some(prop) = callee.child_by_field_name("property") {
                            if let Ok(t) = prop.utf8_text(source) {
                                fallback = Some(t.to_string());
                            }
                        }
                    }
                }
            }
        }
        cur = p.parent();
    }
    fallback
}

/// Build the qualified id for a JS/TS arrow/function-expression definition
/// (`const f = () => …`) or a bound object-literal method (`{ method: () => … }`).
///
/// We walk ancestors and collect, innermost-last:
/// - the enclosing class name (so a class field arrow reads `Cls/field`);
/// - the binding name of any enclosing arrow/function-expression const, plain
///   `function_declaration`, or `method_definition` (so a helper defined inside
///   another function reads `outerFn/innerHelper` — the granularity the
///   nav-eval GRANULARITY cohort wants);
/// - for a pair, the object's own binding name as the immediate parent segment.
///
/// The separator is `/` (the project's entity-id separator, matching the
/// `module/symbol` ids the daemon already emits) rather than the language's
/// `.`/`::` — these are synthetic nav ids, not real language paths.
fn arrow_qualified_name(bare: &str, def_node: Node, is_pair: bool, source: &[u8]) -> String {
    let mut segments: Vec<String> = Vec::new();

    // For a pair, the nearest segment is the object's binding name; for an
    // unbound callable pair (a builder resolver) fall back to the enclosing
    // builder-field name so the id stays distinct + stable across files
    // (`addComment/resolve` rather than a bare `resolve` that collides with
    // every other resolver in the file).
    if is_pair {
        if let Some(obj) = bound_object_name(def_node, source) {
            segments.push(obj);
        } else if let Some(field) = enclosing_builder_field_name(def_node, source) {
            segments.push(field);
        }
    }

    // Climb the ancestor chain collecting enclosing named definitions.
    let mut cur = def_node.parent();
    while let Some(p) = cur {
        match p.kind() {
            "class_declaration" => {
                if let Some(n) = p
                    .child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source).ok())
                {
                    segments.push(n.to_string());
                }
            }
            "function_declaration" | "method_definition" => {
                if let Some(n) = p
                    .child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source).ok())
                {
                    segments.push(n.to_string());
                }
            }
            // An enclosing `const outer = () => { const inner = … }`: the
            // arrow's declarator carries the binding name. An enclosing
            // CLASS-FIELD arrow (`class C { handler = () => { const inner =
            // … } }`) carries it on the field definition instead — `name:` in
            // the TS grammar (`public_field_definition`), `property:` in the
            // JS grammar (`field_definition`).
            "arrow_function" | "function_expression" => {
                if let Some(decl) = p.parent() {
                    match decl.kind() {
                        "variable_declarator" => {
                            if let Some(n) = decl
                                .child_by_field_name("name")
                                .and_then(|n| n.utf8_text(source).ok())
                            {
                                segments.push(n.to_string());
                            }
                        }
                        "public_field_definition" | "field_definition" => {
                            if let Some(n) = decl
                                .child_by_field_name("name")
                                .or_else(|| decl.child_by_field_name("property"))
                                .and_then(|n| n.utf8_text(source).ok())
                            {
                                segments.push(n.to_string());
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        cur = p.parent();
    }

    if segments.is_empty() {
        bare.to_string()
    } else {
        segments.reverse();
        let mut s = segments.join("/");
        s.push('/');
        s.push_str(bare);
        s
    }
}

/// Locate the first ERROR or MISSING node in the tree, depth-first. The
/// caller only invokes this once `root.has_error()` is already true, so a
/// match is expected; we still return `Option` to stay total. Subtrees
/// without errors are pruned via `has_error()` so this is cheap even on
/// large clean-but-for-one-spot files.
fn first_syntax_error(node: Node) -> Option<Node> {
    if node.is_error() || node.is_missing() {
        return Some(node);
    }
    if !node.has_error() {
        return None;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(found) = first_syntax_error(child) {
            return Some(found);
        }
    }
    None
}

/// True iff `node` has any ancestor whose kind matches `kind`.
fn has_ancestor(node: Node, kind: &str) -> bool {
    let mut cur = node.parent();
    while let Some(p) = cur {
        if p.kind() == kind {
            return true;
        }
        cur = p.parent();
    }
    false
}

/// Extract a callable identifier from a call-like node.
///
/// We resolve simple textual targets:
/// - `foo(...)`               → `"foo"`
/// - `obj.foo(...)`           → `"foo"` (drop the receiver — daemon resolves)
/// - `Mod::foo(...)`          → `"foo"`
/// - `obj.foo.bar(...)`       → `"bar"`
/// - `foo()()`, dynamic       → `None` (skip)
fn call_target_name(node: &Node, source: &[u8]) -> Option<String> {
    // `call_expression` / `new_expression` / `method_call_expression`
    // all expose the callable side either under field name "function"
    // or "method" (Rust's method_call_expression).
    let target = node
        .child_by_field_name("function")
        .or_else(|| node.child_by_field_name("method"))
        .or_else(|| node.child_by_field_name("constructor"))?;

    target_identifier(target, source)
}

/// Extract the RECEIVER identifier of a member-access call, if any.
///
/// For a `call_expression` whose `function` child is a `member_expression`
/// (`recv.method(...)`), return the receiver's identifier text. We resolve
/// the *immediate object* of the called member (the segment directly to the
/// left of the method name), NOT the leftmost root:
/// - `api.search(x)`        → `Some("api")`
/// - `a.b.c()`              → `Some("b")`   (immediate object of `.c`)
/// - `foo()`                → `None`        (bare call, no receiver)
/// - `this.x()`             → `Some("this")`
/// - `arr[i].run()`         → `None`        (object is a subscript, not a name)
/// - `getThing().run()`     → `None`        (object is a call, not a name)
///
/// We deliberately stop at the immediate object rather than walking to the
/// leftmost root: it is the segment the daemon needs to bind (`api` in
/// `api.search`, the local `import` name), and it stays well-defined for
/// chains. When the immediate object is not a plain identifier (a subscript,
/// a call, a parenthesized expr, etc.) we return `None` — we only emit a
/// receiver we can attribute to a binding.
///
/// Only TS/JS/TSX/Astro (`member_expression`) participate; other grammars
/// fall through to `None` (receiver is an optional, per-language field).
fn call_receiver_name(node: &Node, source: &[u8]) -> Option<String> {
    let func = node
        .child_by_field_name("function")
        .or_else(|| node.child_by_field_name("constructor"))?;
    if func.kind() != "member_expression" {
        return None;
    }
    let object = func.child_by_field_name("object")?;
    match object.kind() {
        // A plain receiver binding (`api`, a local import) or `this`/`super`.
        "identifier" | "this" | "super" | "shorthand_property_identifier" => {
            object.utf8_text(source).ok().map(|s| s.to_string())
        }
        // `a.b.c()` — the immediate object is itself `a.b`; its rightmost
        // property (`b`) is the receiver of `.c`.
        "member_expression" => object
            .child_by_field_name("property")
            .and_then(|p| p.utf8_text(source).ok())
            .map(|s| s.to_string()),
        // Subscript / call / paren / anything else: not a nameable binding.
        _ => None,
    }
}

/// Extract the FULL receiver chain of a member-access call, ROOT→immediate
/// object, when it is a multi-segment chain of plain property accesses rooted
/// at a nameable binding.
///
/// - `api.search(x)`        → `None`                  (single segment — use `receiver`)
/// - `api.client.search()`  → `Some(["api","client"])` (root `api`, object `client`)
/// - `a.b.c.run()`          → `Some(["a","b","c"])`
/// - `this.svc.run()`       → `Some(["this","svc"])`
/// - `foo()`                → `None`                  (no receiver)
/// - `arr[i].client.run()`  → `None`                  (root is a subscript, unbindable)
/// - `getThing().run()`     → `None`                  (object is a call, unbindable)
///
/// We only return a chain when EVERY segment is a plain property access and the
/// root is an `identifier`/`this`/`super`. The daemon binds the root to an
/// import `local` and walks the remaining segments to the member. A
/// single-segment chain returns `None` so the common case keeps emitting only
/// the immediate-object `receiver` (byte-identical wire). Dynamic/computed
/// roots (subscript, call, paren) return `None` — they're not statically
/// bindable (see {@link call_receiver_name}).
///
/// Only TS/JS/TSX/Astro (`member_expression`) participate.
fn call_receiver_chain(node: &Node, source: &[u8]) -> Option<Vec<String>> {
    let func = node
        .child_by_field_name("function")
        .or_else(|| node.child_by_field_name("constructor"))?;
    if func.kind() != "member_expression" {
        return None;
    }
    // Walk down the `object` spine collecting property names, deepest-first.
    // `func.object` is the immediate object; each nested `member_expression`
    // contributes its `property` (the segment to the left of the next dot).
    let mut segments_rev: Vec<String> = Vec::new();
    let mut cur = func.child_by_field_name("object")?;
    loop {
        match cur.kind() {
            "member_expression" => {
                let prop = cur.child_by_field_name("property")?;
                segments_rev.push(prop.utf8_text(source).ok()?.to_string());
                cur = cur.child_by_field_name("object")?;
            }
            "identifier" | "this" | "super" | "shorthand_property_identifier" => {
                // Reached the root binding.
                segments_rev.push(cur.utf8_text(source).ok()?.to_string());
                break;
            }
            // Subscript / call / paren / anything non-nameable → unbindable root.
            _ => return None,
        }
    }
    // segments_rev is [immediate-object, …, root]; reverse to root→object.
    if segments_rev.len() < 2 {
        // Single segment — the immediate-object `receiver` already covers it.
        return None;
    }
    segments_rev.reverse();
    Some(segments_rev)
}

/// Extract the LOCAL binding name(s) an `import` statement introduces, for
/// JS/TS/TSX/Astro. Returns `None` (→ no `local` field on the wire) for a
/// side-effect import (`import "x"`) and for non-JS languages (where binding
/// extraction is not yet a priority).
///
/// The shapes (tree-sitter-typescript / -javascript `import_clause`):
/// - `import Foo from "x"`               → `["Foo"]`        (default `identifier`)
/// - `import { a, b } from "x"`          → `["a","b"]`      (`named_imports`)
/// - `import { a as b } from "x"`        → `["b"]`          (the LOCAL alias)
/// - `import * as ns from "x"`           → `["ns"]`         (`namespace_import`)
/// - `import Foo, { a } from "x"`        → `["Foo","a"]`    (default + named)
/// - `import "x"`                        → `None`           (side-effect)
/// - `import type { T } from "x"`        → `["T"]`          (type-only, same shape)
fn import_local_bindings(node: &Node, language: Language, source: &[u8]) -> Option<Vec<String>> {
    match language {
        Language::TypeScript | Language::Tsx | Language::JavaScript | Language::Astro => {}
        _ => return None,
    }
    if node.kind() != "import_statement" {
        return None;
    }
    let mut out: Vec<String> = Vec::new();
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() == "import_clause" {
            collect_import_clause_bindings(child, source, &mut out);
        } else if child.kind() == "import_require_clause" {
            // TS `import foo = require("./bar")` — the binding is the clause's
            // bare `identifier` child (the grammar exposes no `name` field).
            let mut c2 = child.walk();
            for gc in child.named_children(&mut c2) {
                if gc.kind() == "identifier" {
                    if let Ok(t) = gc.utf8_text(source) {
                        out.push(t.to_string());
                    }
                }
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Walk an `import_clause` and append every local binding name to `out`.
fn collect_import_clause_bindings(clause: Node, source: &[u8], out: &mut Vec<String>) {
    let mut cursor = clause.walk();
    for child in clause.named_children(&mut cursor) {
        match child.kind() {
            // `import Foo from …` — the default binding is a bare identifier
            // child of the clause.
            "identifier" => {
                if let Ok(t) = child.utf8_text(source) {
                    out.push(t.to_string());
                }
            }
            // `import * as ns from …`
            "namespace_import" => {
                // The alias is the (only) identifier child after `* as`.
                let mut c2 = child.walk();
                for gc in child.named_children(&mut c2) {
                    if gc.kind() == "identifier" {
                        if let Ok(t) = gc.utf8_text(source) {
                            out.push(t.to_string());
                        }
                    }
                }
            }
            // `import { a, b as c } from …`
            "named_imports" => {
                let mut c2 = child.walk();
                for spec in child.named_children(&mut c2) {
                    if spec.kind() == "import_specifier" {
                        // `alias` field is the LOCAL name for `a as b`; without
                        // an alias the `name` field IS the local binding.
                        let local = spec
                            .child_by_field_name("alias")
                            .or_else(|| spec.child_by_field_name("name"));
                        if let Some(n) = local {
                            if let Ok(t) = n.utf8_text(source) {
                                out.push(t.to_string());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

/// Extract the ALIASED named bindings of a JS/TS/TSX/Astro `import` statement,
/// as `{local, imported}` pairs where the local alias differs from the
/// originally-exported name. Returns `None` (→ no `import_aliases` field on the
/// wire) when the import introduces no aliases, for side-effect imports, and for
/// non-JS languages.
///
/// Only the `named_imports` `import { a as b }` shape can alias. A namespace
/// `import * as ns` binds the whole module to `ns` (recoverable from `local`,
/// not a symbol alias) and a default `import Foo` likewise — neither is emitted
/// here. Mirrors {@link collect_import_clause_bindings}'s shape handling.
fn import_alias_pairs(node: &Node, language: Language, source: &[u8]) -> Option<Vec<ImportAlias>> {
    match language {
        Language::TypeScript | Language::Tsx | Language::JavaScript | Language::Astro => {}
        _ => return None,
    }
    if node.kind() != "import_statement" {
        return None;
    }
    let mut out: Vec<ImportAlias> = Vec::new();
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() != "import_clause" {
            continue;
        }
        let mut c2 = child.walk();
        for clause_child in child.named_children(&mut c2) {
            if clause_child.kind() != "named_imports" {
                continue;
            }
            let mut c3 = clause_child.walk();
            for spec in clause_child.named_children(&mut c3) {
                if spec.kind() != "import_specifier" {
                    continue;
                }
                // `import { a as b }` → `name` = `a` (imported), `alias` = `b`
                // (local). Without an alias the `name` IS the local binding and
                // there is nothing to map, so we skip it.
                let alias = spec.child_by_field_name("alias");
                let name = spec.child_by_field_name("name");
                if let (Some(alias), Some(name)) = (alias, name) {
                    if let (Ok(local), Ok(imported)) =
                        (alias.utf8_text(source), name.utf8_text(source))
                    {
                        if local != imported {
                            out.push(ImportAlias {
                                local: local.to_string(),
                                imported: imported.to_string(),
                            });
                        }
                    }
                }
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// True when a `definition.cjs_export` capture (an `assignment_expression`
/// whose right side is a callable literal) assigns to the module's EXPORT
/// surface — i.e. the member's object is exactly the identifier `exports` or
/// the member expression `module.exports`. Everything else
/// (`Foo.prototype.bar = fn`, `res.send = fn`, `this.handler = fn`) is a plain
/// object mutation and is NOT promoted to a definition.
fn cjs_export_target(assign_node: Node, source: &[u8]) -> bool {
    let Some(left) = assign_node.child_by_field_name("left") else {
        return false;
    };
    if left.kind() != "member_expression" {
        return false;
    }
    let Some(object) = left.child_by_field_name("object") else {
        return false;
    };
    match object.kind() {
        // `exports.foo = …`
        "identifier" => object.utf8_text(source).ok() == Some("exports"),
        // `module.exports.foo = …`
        "member_expression" => {
            let obj = object
                .child_by_field_name("object")
                .and_then(|n| n.utf8_text(source).ok());
            let prop = object
                .child_by_field_name("property")
                .and_then(|n| n.utf8_text(source).ok());
            obj == Some("module") && prop == Some("exports")
        }
        _ => false,
    }
}

/// True for the JS-family grammars where a CommonJS `require()` call is a
/// module import. Astro frontmatter is TypeScript, so it participates too.
fn is_js_family(language: Language) -> bool {
    matches!(
        language,
        Language::JavaScript | Language::TypeScript | Language::Tsx | Language::Astro
    )
}

/// If `node` is a CommonJS `require("<string literal>")` call, return the
/// module specifier — else `None`.
///
/// STRICT by design (never invent an edge):
/// - the callee must be the bare identifier `require` (`require.resolve(…)`,
///   `ctx.require(…)` and friends do NOT match — they stay ordinary calls);
/// - the arguments must be EXACTLY ONE plain `string` literal. A computed or
///   dynamic specifier (`require(name)`, `require("./" + x)`), extra args, and
///   template strings (even substitution-free ones) all return `None`, so the
///   call keeps its legacy unresolved-CALL behavior.
///
/// An empty specifier (`require("")`) is rejected too — it can never resolve
/// and would only add a `?:` placeholder.
fn require_specifier(node: &Node, source: &[u8]) -> Option<String> {
    if node.kind() != "call_expression" {
        return None;
    }
    // TS `import foo = require("./bar")`: the require call sits INSIDE an
    // `import_require_clause`, and the `@import` (import_statement) path
    // already emits that edge with its `local` binding — skip here or the
    // same import would be emitted twice.
    if node.parent().map(|p| p.kind()) == Some("import_require_clause") {
        return None;
    }
    let func = node.child_by_field_name("function")?;
    if func.kind() != "identifier" || func.utf8_text(source).ok()? != "require" {
        return None;
    }
    let args = node.child_by_field_name("arguments")?;
    let mut cursor = args.walk();
    let named: Vec<Node> = args.named_children(&mut cursor).collect();
    if named.len() != 1 || named[0].kind() != "string" {
        return None;
    }
    let spec = string_literal_value(named[0], source)?;
    if spec.is_empty() {
        None
    } else {
        Some(spec)
    }
}

/// Derive the `local` binding name(s) and aliased `{local, imported}` pairs a
/// CommonJS `require("…")` call introduces, from the binding form AROUND the
/// call node. Mirrors the ESM `import_local_bindings`/`import_alias_pairs`
/// wire semantics so the daemon's Tier-2 member-call resolution treats a
/// require binding exactly like the equivalent ESM import:
///
/// - `const x = require('./y')` → local `["x"]` (≙ `import * as x` / default)
/// - `const {a, b: c} = require('./y')` → local `["a","c"]`, aliases
///   `[{local:"c",imported:"b"}]` (≙ `import { a, b as c }`)
/// - `const {...rest} = require('./y')` → local `["rest"]` (namespace-ish)
/// - `const z = require('./y').thing` → local `["z"]`, aliases
///   `[{local:"z",imported:"thing"}]` (≙ `import { thing as z }`)
/// - `require('./y')` → `(None, None)` (side-effect)
/// - `module.exports = require('./y')` → `(None, None)` (re-export; no local)
/// - `require('debug')('express')` → `(None, None)` (binds the CALL result,
///   not the module — conservatively no local)
///
/// Nested destructuring (`{a: {b}}`) and array patterns are skipped
/// (conservative — no binding rather than a wrong one).
fn require_bindings(
    node: &Node,
    source: &[u8],
) -> (Option<Vec<String>>, Option<Vec<ImportAlias>>) {
    let Some(parent) = node.parent() else {
        return (None, None);
    };
    match parent.kind() {
        // `const x = require('./y')` / `const {…} = require('./y')`.
        "variable_declarator" => {
            // The require call must be the declarator's VALUE (not, say, a
            // computed-property key somewhere inside the name pattern).
            if parent.child_by_field_name("value").map(|v| v.id()) != Some(node.id()) {
                return (None, None);
            }
            let Some(name) = parent.child_by_field_name("name") else {
                return (None, None);
            };
            match name.kind() {
                "identifier" => match name.utf8_text(source) {
                    Ok(t) => (Some(vec![t.to_string()]), None),
                    Err(_) => (None, None),
                },
                "object_pattern" => {
                    let mut locals: Vec<String> = Vec::new();
                    let mut aliases: Vec<ImportAlias> = Vec::new();
                    let mut cursor = name.walk();
                    for child in name.named_children(&mut cursor) {
                        collect_object_pattern_binding(child, source, &mut locals, &mut aliases);
                    }
                    (
                        if locals.is_empty() { None } else { Some(locals) },
                        if aliases.is_empty() { None } else { Some(aliases) },
                    )
                }
                _ => (None, None),
            }
        }
        // `const z = require('./y').thing` — the require call is the OBJECT of
        // a member access whose result is bound by a declarator. The local
        // binds to the MEMBER, exactly like `import { thing as z }`.
        "member_expression" => {
            let Some(prop) = parent.child_by_field_name("property") else {
                return (None, None);
            };
            let Some(gp) = parent.parent() else {
                return (None, None);
            };
            if gp.kind() != "variable_declarator"
                || gp.child_by_field_name("value").map(|v| v.id()) != Some(parent.id())
            {
                return (None, None);
            }
            let Some(name) = gp.child_by_field_name("name") else {
                return (None, None);
            };
            if name.kind() != "identifier" {
                return (None, None);
            }
            let (Ok(local), Ok(imported)) = (name.utf8_text(source), prop.utf8_text(source))
            else {
                return (None, None);
            };
            let aliases = if local != imported {
                Some(vec![ImportAlias {
                    local: local.to_string(),
                    imported: imported.to_string(),
                }])
            } else {
                None
            };
            (Some(vec![local.to_string()]), aliases)
        }
        // Bare `require('./y');`, `module.exports = require('./y')`, a require
        // in call/argument position, etc. — no local binding introduced.
        _ => (None, None),
    }
}

/// Append the binding(s) of one `object_pattern` child to `locals`/`aliases`.
/// Handles the destructured-require shapes (tree-sitter-javascript /
/// -typescript spell them identically):
/// - `{a}` → `shorthand_property_identifier_pattern` (local `a`)
/// - `{b: c}` → `pair_pattern` key `b`, value `identifier c` (local `c`,
///   alias `{local:"c", imported:"b"}`)
/// - `{a = 1}` → `object_assignment_pattern`, recurse on its `left`
/// - `{...rest}` → `rest_pattern` (local `rest`, no alias — binds the
///   remaining module surface like a namespace)
/// - nested patterns (`{a: {b}}`) are skipped (conservative).
fn collect_object_pattern_binding(
    node: Node,
    source: &[u8],
    locals: &mut Vec<String>,
    aliases: &mut Vec<ImportAlias>,
) {
    match node.kind() {
        "shorthand_property_identifier_pattern" => {
            if let Ok(t) = node.utf8_text(source) {
                locals.push(t.to_string());
            }
        }
        "pair_pattern" => {
            let key = node.child_by_field_name("key");
            let value = node.child_by_field_name("value");
            let (Some(key), Some(value)) = (key, value) else {
                return;
            };
            if value.kind() != "identifier" {
                return; // nested pattern — skip, conservative
            }
            let (Ok(imported), Ok(local)) = (key.utf8_text(source), value.utf8_text(source))
            else {
                return;
            };
            locals.push(local.to_string());
            if local != imported {
                aliases.push(ImportAlias {
                    local: local.to_string(),
                    imported: imported.to_string(),
                });
            }
        }
        // `{a = 1}` — the binding lives on the pattern's `left`.
        "object_assignment_pattern" => {
            if let Some(left) = node.child_by_field_name("left") {
                collect_object_pattern_binding(left, source, locals, aliases);
            }
        }
        // `{...rest}` — the lone identifier child is the binding.
        "rest_pattern" => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if child.kind() == "identifier" {
                    if let Ok(t) = child.utf8_text(source) {
                        locals.push(t.to_string());
                    }
                }
            }
        }
        _ => {}
    }
}

fn target_identifier(node: Node, source: &[u8]) -> Option<String> {
    match node.kind() {
        // Bare identifiers across all our supported grammars.
        // `private_property_identifier` is a JS/TS `#private` member name
        // (`this.#dispatch(...)`); its text INCLUDES the leading `#`, matching
        // the `C.#name` entity naming, so calls to #private methods resolve.
        "identifier" | "type_identifier" | "field_identifier" | "property_identifier"
        | "private_property_identifier" => {
            node.utf8_text(source).ok().map(|s| s.to_string())
        }
        // `a.b.c` / `obj.method` — pick the rightmost identifier-ish child.
        "attribute" | "member_expression" | "field_expression" | "selector_expression" => {
            // Last named child is typically the property/field/selector.
            let n = node.named_child_count();
            if n == 0 {
                return None;
            }
            let last = node.named_child(n - 1)?;
            target_identifier(last, source)
        }
        // Rust `Mod::foo` / `Mod::SubMod::foo` — last segment is the
        // callable.
        "scoped_identifier" => {
            let last = node.child_by_field_name("name")?;
            target_identifier(last, source)
        }
        // Fallback: skip anything we don't recognize. Better to omit a
        // call than to emit garbage targets.
        _ => None,
    }
}

/// Enumerate every imported symbol mentioned in an import statement.
/// Returned strings are the raw module paths / symbol names exactly as
/// they appear in source — the daemon performs final resolution.
fn import_targets(node: &Node, language: Language, source: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    match language {
        Language::Python => python_imports(node, source, &mut out),
        Language::TypeScript | Language::Tsx | Language::JavaScript | Language::Astro => {
            js_imports(node, source, &mut out)
        }
        Language::Rust => rust_imports(node, source, &mut out),
        Language::Go => go_imports(node, source, &mut out),
    }
    out
}

fn python_imports(node: &Node, source: &[u8], out: &mut Vec<String>) {
    // `import foo` / `import foo as bar`
    if node.kind() == "import_statement" {
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if let Some(name) = python_dotted_name(child, source) {
                out.push(name);
            }
        }
        return;
    }
    // `from foo import a, b`
    if node.kind() == "import_from_statement" {
        if let Some(module) = node
            .child_by_field_name("module_name")
            .and_then(|n| python_dotted_name(n, source))
        {
            // Emit the source module first, then each imported name as
            // a qualified path so the daemon can resolve either form.
            let mut cursor = node.walk();
            let mut emitted_any_name = false;
            for child in node.named_children(&mut cursor) {
                if child.kind() == "dotted_name" || child.kind() == "aliased_import" {
                    // skip the module name itself (handled above) — it
                    // sits in the `module_name` field; named_children
                    // returns it too.
                    if child.start_byte()
                        == node
                            .child_by_field_name("module_name")
                            .map(|n| n.start_byte())
                            .unwrap_or(usize::MAX)
                    {
                        continue;
                    }
                    if let Some(name) = python_dotted_name(child, source) {
                        out.push(format!("{}.{}", module, name));
                        emitted_any_name = true;
                    }
                }
            }
            if !emitted_any_name {
                out.push(module);
            }
        }
    }
}

fn python_dotted_name(node: Node, source: &[u8]) -> Option<String> {
    match node.kind() {
        "dotted_name" | "identifier" => node.utf8_text(source).ok().map(|s| s.to_string()),
        "aliased_import" => node
            .child_by_field_name("name")
            .and_then(|n| python_dotted_name(n, source)),
        _ => None,
    }
}

fn js_imports(node: &Node, source: &[u8], out: &mut Vec<String>) {
    // Tree-sitter exposes the source string under the `source` field
    // of `import_statement` as a `string` node containing a
    // `string_fragment`.
    if let Some(source_node) = node.child_by_field_name("source") {
        if let Some(s) = string_literal_value(source_node, source) {
            out.push(s);
        }
        return;
    }
    // TS CJS-interop `import foo = require("./bar")` — an `import_statement`
    // whose specifier lives on the `import_require_clause` child's `source`
    // field, NOT on the statement itself (see TREE_SITTER_NOTES.md "CommonJS").
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() == "import_require_clause" {
            if let Some(source_node) = child.child_by_field_name("source") {
                if let Some(s) = string_literal_value(source_node, source) {
                    out.push(s);
                }
            }
        }
    }
}

fn rust_imports(node: &Node, source: &[u8], out: &mut Vec<String>) {
    // The `argument` field of `use_declaration` holds whatever shape
    // the path takes — a bare identifier, a `scoped_identifier`, a
    // `scoped_use_list` (grouped: `a::{b, c}`), a `use_list` (rare,
    // e.g. `use {a, b};`), a `use_wildcard` (`a::*`), or a
    // `use_as_clause` (`a as b`). `expand_rust_use_path` walks all of
    // them recursively and pushes one fully-qualified `dst_name` per
    // leaf so the daemon never has to parse Rust path syntax itself.
    if let Some(arg) = node.child_by_field_name("argument") {
        expand_rust_use_path(arg, None, source, out);
    }
}

/// Walk a Rust `use_declaration`'s argument subtree and append one
/// `dst_name` to `out` for every imported symbol.
///
/// `prefix` is the path accumulated from enclosing `scoped_use_list`
/// segments — e.g. when descending into the `use_list` of
/// `use a::{b, c}` the prefix is `"a"`. We `::`-join it with the leaf
/// path as we emit. `None` means "no prefix yet" (top level).
///
/// Important grammar notes (tree-sitter-rust 0.24):
/// - `use_list` does NOT have a `path` field — its parent
///   `scoped_use_list` carries the path.
/// - `use_wildcard` may have an optional path child (`a::*`). With no
///   path child it's just `*` (only legal inside a `use_list`).
/// - `self` inside a `use_list` means "the parent itself"; we emit it
///   as the bare prefix with no extra segment.
/// - `use_as_clause` has `path` and `alias`. We drop the alias — v1
///   doesn't track local rebindings.
fn expand_rust_use_path(node: Node, prefix: Option<&str>, source: &[u8], out: &mut Vec<String>) {
    match node.kind() {
        // Grouped: `prefix::{ inner_list }`.
        "scoped_use_list" => {
            let path_segment = node
                .child_by_field_name("path")
                .and_then(|p| p.utf8_text(source).ok())
                .map(|s| s.to_string());
            let new_prefix = join_prefix(prefix, path_segment.as_deref());
            if let Some(list) = node.child_by_field_name("list") {
                expand_rust_use_path(list, new_prefix.as_deref(), source, out);
            }
        }
        // Bare `use { ... };` (rare). No new prefix segment.
        "use_list" => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                expand_rust_use_path(child, prefix, source, out);
            }
        }
        // `path::*` or `*` (the latter only ever inside a use_list).
        "use_wildcard" => {
            let path_segment = node
                .named_child(0)
                .and_then(|p| p.utf8_text(source).ok())
                .map(|s| s.to_string());
            let combined = join_prefix(prefix, path_segment.as_deref());
            let dst = match combined {
                Some(p) => format!("{p}::*"),
                None => "*".to_string(),
            };
            out.push(dst);
        }
        // `path as alias` — drop the alias, keep the path.
        "use_as_clause" => {
            if let Some(path) = node.child_by_field_name("path") {
                if let Ok(text) = path.utf8_text(source) {
                    if let Some(joined) = join_prefix(prefix, Some(text)) {
                        out.push(joined);
                    }
                }
            }
        }
        // `self` inside a `use_list` — refers to the parent prefix.
        // `use a::{self, b}` → emit `a` for the self leaf.
        "self" => {
            if let Some(p) = prefix {
                out.push(p.to_string());
            }
            // A bare `use self;` is illegal, so prefix=None is unreachable
            // in practice; silently drop if we ever see it.
        }
        // Everything else is a path-shaped leaf: `identifier`,
        // `scoped_identifier`, `crate`, `super`, `metavariable`. The
        // raw text is exactly what we want for `dst_name`.
        _ => {
            if let Ok(text) = node.utf8_text(source) {
                if let Some(joined) = join_prefix(prefix, Some(text)) {
                    out.push(joined);
                }
            }
        }
    }
}

/// `::`-join an optional prefix with an optional new segment. Returns
/// `None` only when both are `None`.
fn join_prefix(prefix: Option<&str>, segment: Option<&str>) -> Option<String> {
    match (prefix, segment) {
        (Some(p), Some(s)) => Some(format!("{p}::{s}")),
        (Some(p), None) => Some(p.to_string()),
        (None, Some(s)) => Some(s.to_string()),
        (None, None) => None,
    }
}

fn go_imports(node: &Node, source: &[u8], out: &mut Vec<String>) {
    // `import "foo/bar"` (single) or `import ( ... )` (block).
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        match child.kind() {
            "import_spec" => {
                if let Some(path) = child.child_by_field_name("path") {
                    if let Some(s) = string_literal_value(path, source) {
                        out.push(s);
                    }
                }
            }
            "import_spec_list" => go_imports(&child, source, out),
            _ => {}
        }
    }
}

/// Pull the textual content out of a tree-sitter string node, stripping
/// the surrounding quote characters. Falls back to the raw slice if the
/// expected `string_fragment` child isn't present.
fn string_literal_value(node: Node, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() == "string_fragment" || child.kind() == "interpreted_string_literal_content"
        {
            if let Ok(s) = child.utf8_text(source) {
                return Some(s.to_string());
            }
        }
    }
    // Fallback: raw text with quotes stripped.
    let text = node.utf8_text(source).ok()?;
    let trimmed = text
        .trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`');
    Some(trimmed.to_string())
}

/// 1-indexed inclusive line count for the module node's `range`.
/// Counts every `\n` plus one extra line if the file is non-empty and
/// doesn't end with a newline. An empty file is reported as one line
/// (callers clamp to `>=1` regardless, but the policy lives here so
/// it's the same everywhere).
fn total_line_count(source: &[u8]) -> usize {
    if source.is_empty() {
        return 1;
    }
    let newlines = bytecount_newlines(source);
    let ends_with_newline = source.last() == Some(&b'\n');
    if ends_with_newline {
        newlines.max(1)
    } else {
        newlines + 1
    }
}

/// Count occurrences of `\n` in `source`. Inlined here to avoid pulling
/// in another dependency for one usage site.
fn bytecount_newlines(source: &[u8]) -> usize {
    source.iter().filter(|&&b| b == b'\n').count()
}

/// Slice an `.astro` file down to its `---…---` frontmatter — the TypeScript
/// block (imports, `interface Props`, `const { … } = Astro.props`, server
/// logic) that carries all the code intelligence. The HTML+JSX template below
/// the closing fence is intentionally NOT indexed (low value; would also need
/// a different grammar). See TREE_SITTER_NOTES.md "Astro".
///
/// Returns `(frontmatter_bytes, line_offset)` where `line_offset` is the number
/// of file lines that precede the frontmatter content (so a node on the first
/// frontmatter line maps to `line_offset + 1` in the real file). The returned
/// slice covers from the byte after the opening fence's newline up to the start
/// of the closing fence line, so its internal byte offsets line up with
/// tree-sitter's view of that slice.
///
/// Astro requires the frontmatter, if present, to be the very first thing in
/// the file (only leading whitespace/blank lines may precede the opening `---`).
/// We tolerate leading blank lines. Returns `None` when there is no opening
/// fence or it is never closed — the caller then emits just the module node.
fn astro_frontmatter(source: &[u8]) -> Option<(&[u8], usize)> {
    // Walk line by line tracking byte offsets. A "fence" line is one whose
    // trimmed content is exactly "---". `open_fence` holds, once we've seen the
    // opening fence, `(content_start_byte, content_start_line_index)`.
    let mut line_start = 0usize;
    let mut line_index = 0usize; // 0-based line number of `line_start`
    let mut open_fence: Option<(usize, usize)> = None;

    let n = source.len();
    while line_start < n {
        // Find end of this line (index of '\n', or EOF).
        let mut j = line_start;
        while j < n && source[j] != b'\n' {
            j += 1;
        }
        let trimmed = trim_ascii(&source[line_start..j]);
        let next_line_start = if j < n { j + 1 } else { n };

        match open_fence {
            // Closing fence: frontmatter is [content_start, line_start).
            Some((content_start, content_line)) if trimmed == b"---" => {
                return Some((&source[content_start..line_start], content_line));
            }
            Some(_) => {} // inside frontmatter, keep scanning for the close
            None => {
                if trimmed == b"---" {
                    // Content begins on the next line.
                    open_fence = Some((next_line_start, line_index + 1));
                } else if !trimmed.is_empty() {
                    // First non-blank line is not a fence → no frontmatter.
                    return None;
                }
                // else: leading blank line, keep scanning.
            }
        }

        line_start = next_line_start;
        line_index += 1;
    }
    // Opening fence found but never closed (or no fence at all).
    None
}

/// Trim leading/trailing ASCII whitespace from a byte slice. Local helper so we
/// don't pull in a dependency; `[u8]::trim_ascii` is stable but we keep this to
/// stay on the project's conservative MSRV posture and to be explicit.
fn trim_ascii(mut s: &[u8]) -> &[u8] {
    while let [first, rest @ ..] = s {
        if first.is_ascii_whitespace() {
            s = rest;
        } else {
            break;
        }
    }
    while let [rest @ .., last] = s {
        if last.is_ascii_whitespace() {
            s = rest;
        } else {
            break;
        }
    }
    s
}

/// Convenience: extract a file given its on-disk path. Reads the bytes
/// itself; the parallel driver calls this so each worker can do its
/// own I/O without going through a shared lock.
pub fn extract_path(
    root: &Path,
    file_path: &Path,
    language: Language,
    emit_signatures: bool,
) -> Result<FileExtraction> {
    let bytes =
        std::fs::read(file_path).with_context(|| format!("read {}", file_path.display()))?;

    // Reject non-UTF8 early — Tree-sitter expects valid UTF-8 and we
    // need to slice on byte boundaries when hashing.
    if std::str::from_utf8(&bytes).is_err() {
        return Err(anyhow!("file is not valid UTF-8"));
    }

    let rel = file_path
        .strip_prefix(root)
        .unwrap_or(file_path)
        .to_string_lossy()
        .replace('\\', "/");
    extract_file_opts(&rel, &bytes, language, emit_signatures)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn warns(records: &[Record]) -> Vec<&str> {
        records
            .iter()
            .filter_map(|r| match r {
                Record::Warn { message, .. } => Some(message.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn clean_source_emits_no_syntax_warn() {
        let src = b"def hello():\n    return 1\n";
        let out = extract_file("ok.py", src, Language::Python).expect("extract");
        assert!(warns(&out.records).is_empty(), "clean file should not warn");
        // Sanity: it still produced the function node.
        assert!(out
            .records
            .iter()
            .any(|r| matches!(r, Record::Node { name, .. } if name == "hello")));
    }

    #[test]
    fn broken_source_emits_syntax_warn() {
        // Unterminated def / dangling colon — tree-sitter recovers but flags
        // an ERROR/MISSING node, so has_error() is true.
        let src = b"def broken(:\n    x = \n";
        let out = extract_file("bad.py", src, Language::Python).expect("extract");
        let ws = warns(&out.records);
        assert_eq!(ws.len(), 1, "broken file should warn exactly once: {ws:?}");
        assert!(ws[0].contains("syntax error"), "warn names a syntax error: {}", ws[0]);
    }

    #[test]
    fn syntax_warn_leads_the_stream() {
        let src = b"fn broken( {\n";
        let out = extract_file("bad.rs", src, Language::Rust).expect("extract");
        assert!(
            matches!(out.records.first(), Some(Record::Warn { .. })),
            "syntax warn should be the first record"
        );
    }

    // ── Granularity: inner/arrow/nested definitions ────────────────────────

    /// All `(qualified_name, kind)` Node records (excluding the module node).
    fn node_qnames(records: &[Record]) -> Vec<(String, String)> {
        records
            .iter()
            .filter_map(|r| match r {
                Record::Node {
                    qualified_name,
                    kind,
                    ..
                } if kind != "module" => Some((qualified_name.clone(), kind.clone())),
                _ => None,
            })
            .collect()
    }

    fn has_qname(records: &[Record], qname: &str) -> bool {
        node_qnames(records).iter().any(|(q, _)| q == qname)
    }

    /// The `(qualified_name, kind, range)` of every non-module Node record.
    fn node_qname_ranges(records: &[Record]) -> Vec<(String, String, [usize; 2])> {
        records
            .iter()
            .filter_map(|r| match r {
                Record::Node {
                    qualified_name,
                    kind,
                    range,
                    ..
                } if kind != "module" => {
                    Some((qualified_name.clone(), kind.clone(), *range))
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn rust_impl_block_emits_full_span_coverage_node() {
        // `impl Foo { fn bar() {} }` — the block's `impl Foo {` (line 3) and
        // closing `}` (line 7) belong to no method range, so the packer would
        // leak them as header fragments without a coverage node spanning 3..7.
        let src = b"struct Foo { x: u32 }\n\nimpl Foo {\n    fn bar(&self) -> u32 {\n        self.x\n    }\n}\n";
        let out = extract_file("m.rs", src, Language::Rust).expect("extract");
        let nodes = node_qname_ranges(&out.records);

        let impl_node = nodes
            .iter()
            .find(|(q, _, _)| q == "impl Foo")
            .unwrap_or_else(|| panic!("expected `impl Foo` coverage node: {nodes:?}"));
        assert_eq!(impl_node.1, "other", "impl node kind must be `other`");
        assert_eq!(
            impl_node.2,
            [3, 7],
            "impl node must span the whole block (opener..closing brace)"
        );

        // The type and the method are unchanged — no collision, no loss.
        assert!(
            nodes.iter().any(|(q, k, _)| q == "Foo" && k == "class"),
            "struct `Foo` (kind class) must still exist, distinct from `impl Foo`: {nodes:?}"
        );
        assert!(
            nodes.iter().any(|(q, k, _)| q == "Foo::bar" && k == "method"),
            "method `Foo::bar` must still exist: {nodes:?}"
        );
    }

    #[test]
    fn rust_trait_impl_block_names_the_trait() {
        let src = b"struct Foo;\nimpl Display for Foo {\n    fn fmt(&self) {}\n}\n";
        let out = extract_file("m.rs", src, Language::Rust).expect("extract");
        assert!(
            has_qname(&out.records, "impl Display for Foo"),
            "trait impl must be named `impl Display for Foo`: {:?}",
            node_qnames(&out.records)
        );
    }

    #[test]
    fn ts_arrow_const_is_emitted_as_function() {
        let src = b"export const add = (a: number, b: number): number => a + b;\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        assert!(
            has_qname(&out.records, "add"),
            "arrow const `add` must be indexed: {:?}",
            node_qnames(&out.records)
        );
    }

    #[test]
    fn ts_function_expression_const_is_emitted() {
        let src = b"const helper = function (x) { return x; };\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        assert!(has_qname(&out.records, "helper"));
    }

    #[test]
    fn ts_nested_arrow_is_qualified_by_enclosing_fn() {
        let src = b"function outer() {\n  const inner = (n) => n * 2;\n  return inner;\n}\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        assert!(
            has_qname(&out.records, "outer/inner"),
            "nested arrow should be `outer/inner`: {:?}",
            node_qnames(&out.records)
        );
    }

    #[test]
    fn ts_bound_object_methods_are_qualified_methods() {
        let src = b"export const api = {\n  search: (q) => run(q),\n  health: () => ping(),\n};\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let qs = node_qnames(&out.records);
        assert!(
            qs.iter()
                .any(|(q, k)| q == "api/search" && k == "method"),
            "object method `api/search` must be a method: {qs:?}"
        );
        assert!(qs.iter().any(|(q, _)| q == "api/health"));
    }

    #[test]
    fn anonymous_inline_object_methods_are_not_indexed() {
        // A config object passed inline to a call is NOT bound to a name; its
        // arrow methods must NOT explode the index.
        let src = b"register({ onClick: () => fire(), onHover: () => peek() });\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let qs = node_qnames(&out.records);
        assert!(
            qs.iter().all(|(q, _)| q != "onClick" && !q.ends_with("/onClick")),
            "anonymous inline object methods must be skipped: {qs:?}"
        );
    }

    // ── Class-field arrow methods + `#private` methods (the hono idioms) ────

    #[test]
    fn ts_class_field_arrow_is_a_method_qualified_by_class() {
        // hono's ENTIRE Context API is written as class-field arrows
        // (`get = (key) => {…}`) — a `public_field_definition`, not a
        // `method_definition`, so it used to be invisible. It must be a
        // `method` node named with the CLASS-METHOD convention (`Context.get`,
        // dot separator), exactly like a regular method.
        let src = b"export class Context {\n  get = (key: string): unknown => {\n    return lookup(key);\n  };\n  set = (key: string, value: unknown): void => {\n    store(key, value);\n  };\n}\n";
        let out = extract_file("context.ts", src, Language::TypeScript).expect("extract");
        let qs = node_qnames(&out.records);
        assert!(
            qs.iter().any(|(q, k)| q == "Context.get" && k == "method"),
            "class-field arrow must be `Context.get` (method): {qs:?}"
        );
        assert!(
            qs.iter().any(|(q, k)| q == "Context.set" && k == "method"),
            "class-field arrow must be `Context.set` (method): {qs:?}"
        );
        // Caller side: calls INSIDE the field-arrow body attribute to the
        // method entity, not the module/file — chains through it resolve.
        let calls = call_src_dst(&out.records);
        assert!(
            calls.iter().any(|(s, d)| s == "Context.get" && d == "lookup"),
            "call inside a field-arrow body must attribute to `Context.get`: {calls:?}"
        );
    }

    #[test]
    fn ts_private_hash_method_is_indexed_with_hash_name() {
        // ES `#private` methods (`Hono.#dispatch`) — the name node is a
        // `private_property_identifier` whose text INCLUDES the `#`.
        let src = b"export class Hono {\n  fetch(request: Request): Response {\n    return this.#dispatch(request);\n  }\n  #dispatch(request: Request): Response {\n    return getPath(request);\n  }\n}\n";
        let out = extract_file("hono-base.ts", src, Language::TypeScript).expect("extract");
        let qs = node_qnames(&out.records);
        assert!(
            qs.iter().any(|(q, k)| q == "Hono.#dispatch" && k == "method"),
            "`#private` method must be `Hono.#dispatch` (method): {qs:?}"
        );
        let calls = call_src_dst(&out.records);
        // Caller side: a call INSIDE #dispatch's body attributes to it (this is
        // the broken static chain from the hono bench: getPath ← Hono.#dispatch).
        assert!(
            calls.iter().any(|(s, d)| s == "Hono.#dispatch" && d == "getPath"),
            "call inside a #private body must attribute to `Hono.#dispatch`: {calls:?}"
        );
        // Callee side: `this.#dispatch(...)` emits an edge whose dst carries
        // the `#` so it can resolve to the `Hono.#dispatch` entity.
        assert!(
            calls.iter().any(|(s, d)| s == "Hono.fetch" && d == "#dispatch"),
            "`this.#dispatch()` must emit a call edge to `#dispatch`: {calls:?}"
        );
    }

    #[test]
    fn ts_private_hash_field_arrow_is_indexed_data_fields_are_not() {
        // A #private FIELD holding an arrow is a callable method surface
        // (`C.#log`); a #private field holding DATA (`#var = new Map()`) is
        // not, and must stay unindexed (don't explode the index with state).
        let src = b"class C {\n  #var = new Map();\n  #log = (msg: string): void => {\n    sink(msg);\n  };\n}\n";
        let out = extract_file("c.ts", src, Language::TypeScript).expect("extract");
        let qs = node_qnames(&out.records);
        assert!(
            qs.iter().any(|(q, k)| q == "C.#log" && k == "method"),
            "#private field arrow must be `C.#log` (method): {qs:?}"
        );
        assert!(
            qs.iter().all(|(q, _)| q != "C.#var" && !q.ends_with("#var")),
            "#private DATA field must not be indexed: {qs:?}"
        );
        let calls = call_src_dst(&out.records);
        assert!(
            calls.iter().any(|(s, d)| s == "C.#log" && d == "sink"),
            "call inside #private field-arrow body must attribute to `C.#log`: {calls:?}"
        );
    }

    #[test]
    fn tsx_class_field_arrow_and_private_method_are_indexed() {
        // Same grammar family, distinct `Language::Tsx` entry point — pin it.
        let src = b"export class Widget {\n  render = () => {\n    return <div onClick={this.#fire}/>;\n  };\n  #fire(): void {\n    emit();\n  }\n}\n";
        let out = extract_file("widget.tsx", src, Language::Tsx).expect("extract");
        let qs = node_qnames(&out.records);
        assert!(
            qs.iter().any(|(q, k)| q == "Widget.render" && k == "method"),
            "TSX class-field arrow must be `Widget.render`: {qs:?}"
        );
        assert!(
            qs.iter().any(|(q, k)| q == "Widget.#fire" && k == "method"),
            "TSX #private method must be `Widget.#fire`: {qs:?}"
        );
    }

    #[test]
    fn js_class_field_arrow_and_private_method_are_indexed() {
        // Plain-JS class fields ride the JS grammar's `field_definition`
        // (field name `property:`, not `name:`) — pin the JS path too.
        let src = b"class Store {\n  get = (key) => {\n    return this.#read(key);\n  };\n  #read(key) {\n    return fetchRow(key);\n  }\n}\n";
        let out = extract_file("store.js", src, Language::JavaScript).expect("extract");
        let qs = node_qnames(&out.records);
        assert!(
            qs.iter().any(|(q, k)| q == "Store.get" && k == "method"),
            "JS class-field arrow must be `Store.get` (method): {qs:?}"
        );
        assert!(
            qs.iter().any(|(q, k)| q == "Store.#read" && k == "method"),
            "JS #private method must be `Store.#read` (method): {qs:?}"
        );
        let calls = call_src_dst(&out.records);
        assert!(
            calls.iter().any(|(s, d)| s == "Store.get" && d == "#read"),
            "`this.#read()` inside the field arrow must edge from `Store.get`: {calls:?}"
        );
        assert!(
            calls.iter().any(|(s, d)| s == "Store.#read" && d == "fetchRow"),
            "call inside JS #private body must attribute to `Store.#read`: {calls:?}"
        );
    }

    #[test]
    fn nested_arrow_inside_class_field_arrow_is_qualified_by_field() {
        // A helper const-arrow nested in a field-arrow body picks up the field
        // name as a qualifier segment (mirrors `outer/inner` for functions).
        let src = b"class C {\n  handler = () => {\n    const inner = (n) => n * 2;\n    return inner(1);\n  };\n}\n";
        let out = extract_file("c.ts", src, Language::TypeScript).expect("extract");
        let qs = node_qnames(&out.records);
        assert!(
            qs.iter().any(|(q, _)| q == "C/handler/inner"),
            "nested arrow inside a field arrow should be `C/handler/inner`: {qs:?}"
        );
    }

    /// All `(src_name, dst_name)` static_call Edge records.
    fn call_src_dst(records: &[Record]) -> Vec<(String, String)> {
        records
            .iter()
            .filter_map(|r| match r {
                Record::Edge {
                    src_name,
                    dst_name,
                    kind,
                    ..
                } if kind == "static_call" => Some((src_name.clone(), dst_name.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn builder_resolver_pair_is_promoted_and_named_by_field() {
        // A Pothos-style builder resolver: the resolver arrow lives in an
        // anonymous object passed to `builder.mutationField('addComment', …)`.
        // It must be promoted to a distinct entity qualified by the field NAME
        // (`addComment/resolve`), NOT collapsed/skipped — so the bare call inside
        // it is attributed to the resolver rather than the file path (the
        // foreign-repo bare-call resolution bug).
        let src = br#"
builder.mutationField('addComment', (t) =>
  t.field({
    resolve: async (_parent, args, context) => {
      const ok = await checkProjectWriteAccess(context, args.id);
      return ok;
    },
  }),
);
"#;
        let out = extract_file("graphql/comment.ts", src, Language::TypeScript).expect("extract");
        let qs = node_qnames(&out.records);
        assert!(
            qs.iter().any(|(q, _)| q == "addComment/resolve"),
            "resolver must be qualified by its builder field name: {qs:?}"
        );
        // The bare call's src_name is the resolver, not the file path.
        let calls = call_src_dst(&out.records);
        assert!(
            calls
                .iter()
                .any(|(s, d)| s == "addComment/resolve" && d == "checkProjectWriteAccess"),
            "bare call must be attributed to the resolver, not the file: {calls:?}"
        );
    }

    #[test]
    fn bare_call_in_unbound_builder_object_is_not_file_path() {
        // Regression: a bare call inside a builder resolver must NOT fall back to
        // the rel_path as src_name (which silently dropped the edge in the
        // daemon resolver). The src is a real qualified entity name.
        let src = br#"
builder.queryField('photosByProject', (t) =>
  t.field({ resolve: async (_p, args, ctx) => { return await fetchPhotos(ctx, args.id); } }),
);
"#;
        let out = extract_file("graphql/photo.ts", src, Language::TypeScript).expect("extract");
        let calls = call_src_dst(&out.records);
        let bare = calls.iter().find(|(_, d)| d == "fetchPhotos");
        let (src_name, _) = bare.expect("fetchPhotos call edge present");
        assert!(
            !src_name.contains("graphql/photo.ts"),
            "src_name must not be the file path: {src_name}"
        );
        assert_eq!(src_name, "photosByProject/resolve");
    }

    #[test]
    fn bare_callback_in_plain_call_is_still_skipped() {
        // The anonymous-config guard still holds for a BARE (identifier) call:
        // `register({ onClick: () => … })` carries no builder qualifier, so its
        // callable pairs are NOT promoted (no index explosion on inline config).
        let src = b"register({ onSave: () => persist(), onLoad: () => hydrate() });\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let qs = node_qnames(&out.records);
        assert!(
            qs.iter()
                .all(|(q, _)| !q.ends_with("/onSave") && q != "onSave"),
            "inline bare-call config callbacks must stay unindexed: {qs:?}"
        );
    }

    #[test]
    fn js_arrow_const_is_emitted() {
        let src = b"export const f = (a, b) => a + b;\nconst g = x => x;\n";
        let out = extract_file("m.js", src, Language::JavaScript).expect("extract");
        assert!(has_qname(&out.records, "f"));
        assert!(has_qname(&out.records, "g"));
    }

    #[test]
    fn plain_function_declarations_still_emit_unchanged() {
        // Regression guard: the legacy `function`/`class`/`method` extraction is
        // untouched by the arrow additions.
        let src = b"export function foo(a) { return a; }\nclass C { bar() {} }\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        assert!(has_qname(&out.records, "foo"));
        assert!(has_qname(&out.records, "C"));
        assert!(has_qname(&out.records, "C.bar"));
    }

    // ── Member-access call receivers + import local bindings ────────────────

    /// All `(dst_name, receiver)` for `static_call` edges.
    fn static_calls(records: &[Record]) -> Vec<(String, Option<String>)> {
        records
            .iter()
            .filter_map(|r| match r {
                Record::Edge {
                    dst_name,
                    kind,
                    receiver,
                    ..
                } if kind == "static_call" => Some((dst_name.clone(), receiver.clone())),
                _ => None,
            })
            .collect()
    }

    /// All `(dst_name, local)` for `import` edges.
    fn import_locals(records: &[Record]) -> Vec<(String, Option<Vec<String>>)> {
        records
            .iter()
            .filter_map(|r| match r {
                Record::Edge {
                    dst_name,
                    kind,
                    local,
                    ..
                } if kind == "import" => Some((dst_name.clone(), local.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn member_call_emits_receiver_and_member_name() {
        // `api.search(trimmed)` → dst_name "search", receiver "api".
        let src = b"function run(api, trimmed) { return api.search(trimmed); }\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let calls = static_calls(&out.records);
        assert!(
            calls
                .iter()
                .any(|(d, r)| d == "search" && r.as_deref() == Some("api")),
            "api.search() must emit dst=search receiver=api: {calls:?}"
        );
    }

    #[test]
    fn bare_call_has_no_receiver() {
        // `foo()` stays exactly as today: no receiver.
        let src = b"function run() { return foo(); }\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let calls = static_calls(&out.records);
        assert!(
            calls.iter().any(|(d, r)| d == "foo" && r.is_none()),
            "bare foo() must have NO receiver: {calls:?}"
        );
        // And the wire line for the bare call must not carry a `receiver` key.
        let line = out
            .records
            .iter()
            .find_map(|r| match r {
                Record::Edge {
                    dst_name, kind, ..
                } if kind == "static_call" && dst_name == "foo" => {
                    Some(serde_json::to_string(r).unwrap())
                }
                _ => None,
            })
            .expect("foo() edge");
        assert!(
            !line.contains("receiver"),
            "bare-call edge must omit `receiver` on the wire: {line}"
        );
    }

    #[test]
    fn chained_member_call_receiver_is_immediate_object() {
        // `a.b.c()` → receiver is the IMMEDIATE object `b` (documented choice),
        // not the leftmost root `a`.
        let src = b"function run(a) { return a.b.c(); }\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let calls = static_calls(&out.records);
        assert!(
            calls
                .iter()
                .any(|(d, r)| d == "c" && r.as_deref() == Some("b")),
            "a.b.c() must emit dst=c receiver=b (immediate object): {calls:?}"
        );
    }

    #[test]
    fn this_member_call_emits_this_receiver() {
        let src = b"class C { run() { return this.go(); } }\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let calls = static_calls(&out.records);
        assert!(
            calls
                .iter()
                .any(|(d, r)| d == "go" && r.as_deref() == Some("this")),
            "this.go() must emit receiver=this: {calls:?}"
        );
    }

    #[test]
    fn computed_and_call_object_receivers_are_skipped() {
        // `arr[i].run()` — object is a subscript, not a nameable binding → no receiver.
        // `getThing().run()` — object is a call → no receiver.
        let src = b"function f(arr, i) { arr[i].run(); getThing().run(); }\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let calls = static_calls(&out.records);
        let runs: Vec<_> = calls.iter().filter(|(d, _)| d == "run").collect();
        assert!(!runs.is_empty(), "run() calls must still emit: {calls:?}");
        assert!(
            runs.iter().all(|(_, r)| r.is_none()),
            "computed/call object receivers must be skipped: {calls:?}"
        );
    }

    /// All `(dst_name, receiver, receiver_chain)` for `static_call` edges.
    #[allow(clippy::type_complexity)]
    fn static_calls_with_chain(
        records: &[Record],
    ) -> Vec<(String, Option<String>, Option<Vec<String>>)> {
        records
            .iter()
            .filter_map(|r| match r {
                Record::Edge {
                    dst_name,
                    kind,
                    receiver,
                    receiver_chain,
                    ..
                } if kind == "static_call" => Some((
                    dst_name.clone(),
                    receiver.clone(),
                    receiver_chain.clone(),
                )),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn chained_member_call_emits_full_receiver_chain() {
        // `api.client.search()` → dst "search", receiver "client" (immediate
        // object, unchanged), receiver_chain ["api","client"] (root→object).
        let src = b"function run(api) { return api.client.search(); }\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let calls = static_calls_with_chain(&out.records);
        assert!(
            calls.iter().any(|(d, r, c)| d == "search"
                && r.as_deref() == Some("client")
                && c.as_deref() == Some(&["api".to_string(), "client".to_string()][..])),
            "api.client.search() must carry receiver_chain [api,client]: {calls:?}"
        );
    }

    #[test]
    fn deep_chain_emits_all_segments() {
        // `a.b.c.run()` → receiver_chain ["a","b","c"].
        let src = b"function f(a) { a.b.c.run(); }\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let calls = static_calls_with_chain(&out.records);
        assert!(
            calls.iter().any(|(d, _, c)| d == "run"
                && c.as_deref()
                    == Some(&["a".to_string(), "b".to_string(), "c".to_string()][..])),
            "a.b.c.run() must carry chain [a,b,c]: {calls:?}"
        );
    }

    #[test]
    fn single_receiver_call_omits_chain_on_the_wire() {
        // `api.search()` → receiver "api", NO receiver_chain (single segment).
        // The wire line must NOT carry receiver_chain (byte-compat).
        let src = b"function run(api) { return api.search(); }\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let calls = static_calls_with_chain(&out.records);
        assert!(
            calls
                .iter()
                .any(|(d, r, c)| d == "search" && r.as_deref() == Some("api") && c.is_none()),
            "single-segment api.search() must omit receiver_chain: {calls:?}"
        );
        let line = out
            .records
            .iter()
            .find_map(|r| match r {
                Record::Edge { dst_name, kind, .. }
                    if kind == "static_call" && dst_name == "search" =>
                {
                    Some(serde_json::to_string(r).unwrap())
                }
                _ => None,
            })
            .expect("search() edge");
        assert!(
            !line.contains("receiver_chain"),
            "single-receiver edge must omit receiver_chain on the wire: {line}"
        );
    }

    #[test]
    fn computed_root_chain_is_skipped() {
        // `arr[i].client.run()` — root is a subscript → no chain, no receiver.
        // `getThing().client.run()` — root is a call → no chain, no receiver.
        let src =
            b"function f(arr, i) { arr[i].client.run(); getThing().client.run(); }\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let calls = static_calls_with_chain(&out.records);
        let runs: Vec<_> = calls.iter().filter(|(d, _, _)| d == "run").collect();
        assert!(!runs.is_empty(), "run() calls must still emit: {calls:?}");
        assert!(
            runs.iter().all(|(_, _, c)| c.is_none()),
            "computed/call-rooted chains must carry no receiver_chain: {calls:?}"
        );
    }

    // ── Astro template component-usage edges ─────────────────────────────────

    #[test]
    fn astro_template_component_usage_emits_static_call_edge() {
        // `<Stats/>` in the template → static_call edge dst "Stats", receiver
        // "Stats" (binds to the frontmatter import; resolves to the module).
        let src = b"---\nimport Stats from \"~/components/Stats.tsx\";\n---\n<div><Stats client:visible /></div>\n";
        let out = extract_file("viewer/src/pages/index.astro", src, Language::Astro)
            .expect("extract astro");
        let calls = static_calls_with_chain(&out.records);
        assert!(
            calls
                .iter()
                .any(|(d, r, _)| d == "Stats" && r.as_deref() == Some("Stats")),
            "<Stats/> must emit static_call dst=Stats receiver=Stats: {calls:?}"
        );
    }

    #[test]
    fn astro_dotted_component_usage_emits_chain() {
        // `<Foo.Bar/>` → dst "Bar", receiver "Foo", chain None — mirroring a
        // single-segment member call (`api.search()` → receiver `api`, no
        // chain). The `receiver_chain` EXCLUDES the trailing member, so a
        // 2-part component collapses to just the immediate-object receiver.
        let src = b"---\nimport Foo from \"~/components/Foo.tsx\";\n---\n<Foo.Bar />\n";
        let out = extract_file("viewer/src/pages/x.astro", src, Language::Astro)
            .expect("extract astro");
        let calls = static_calls_with_chain(&out.records);
        assert!(
            calls
                .iter()
                .any(|(d, r, c)| d == "Bar" && r.as_deref() == Some("Foo") && c.is_none()),
            "<Foo.Bar/> must emit dst=Bar receiver=Foo chain=None: {calls:?}"
        );
    }

    #[test]
    fn astro_lowercase_html_tags_are_not_edges() {
        // Plain HTML tags (`<div>`, `<p>`) must NOT become component edges.
        let src = b"---\nimport Stats from \"~/components/Stats.tsx\";\n---\n<div><p>hi</p><span/></div>\n";
        let out = extract_file("viewer/src/pages/y.astro", src, Language::Astro)
            .expect("extract astro");
        let calls = static_calls_with_chain(&out.records);
        assert!(
            calls.iter().all(|(d, _, _)| d != "div" && d != "p" && d != "span"),
            "lowercase HTML tags must not be edges: {calls:?}"
        );
    }

    #[test]
    fn astro_component_usage_each_emitted_once() {
        // Paired `<Base>…</Base>` + repeated `<Stats/>` → one edge per distinct
        // component name (the open tag; close tags / repeats deduped).
        let src = b"---\nimport Base from \"~/layouts/Base.astro\";\nimport Stats from \"~/components/Stats.tsx\";\n---\n<Base><Stats /><Stats /></Base>\n";
        let out = extract_file("viewer/src/pages/z.astro", src, Language::Astro)
            .expect("extract astro");
        let calls = static_calls_with_chain(&out.records);
        let stats: Vec<_> = calls.iter().filter(|(d, _, _)| d == "Stats").collect();
        let base: Vec<_> = calls.iter().filter(|(d, _, _)| d == "Base").collect();
        assert_eq!(stats.len(), 1, "Stats usage deduped to one edge: {calls:?}");
        assert_eq!(base.len(), 1, "Base usage one edge: {calls:?}");
    }

    #[test]
    fn named_imports_emit_local_bindings() {
        // `import { api, qk } from "x"` → local ["api","qk"].
        let src = b"import { api, qk } from \"~/api/client\";\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let imports = import_locals(&out.records);
        assert!(
            imports
                .iter()
                .any(|(d, l)| d == "~/api/client"
                    && l.as_deref() == Some(&["api".to_string(), "qk".to_string()][..])),
            "named import must emit local [api, qk]: {imports:?}"
        );
    }

    #[test]
    fn aliased_import_uses_local_alias() {
        // `import { a as b } from "x"` → local ["b"] (the LOCAL name).
        let src = b"import { search as doSearch } from \"~/api/client\";\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let imports = import_locals(&out.records);
        assert!(
            imports
                .iter()
                .any(|(_, l)| l.as_deref() == Some(&["doSearch".to_string()][..])),
            "aliased import must use the local alias `doSearch`: {imports:?}"
        );
    }

    /// All `(dst_name, import_aliases)` for `import` edges.
    #[allow(clippy::type_complexity)]
    fn import_alias_lists(records: &[Record]) -> Vec<(String, Option<Vec<ImportAlias>>)> {
        records
            .iter()
            .filter_map(|r| match r {
                Record::Edge {
                    dst_name,
                    kind,
                    import_aliases,
                    ..
                } if kind == "import" => Some((dst_name.clone(), import_aliases.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn aliased_import_carries_local_and_imported_pair() {
        // `import { checkAccess as ca }` → local ["ca"] AND
        // import_aliases [{local:"ca", imported:"checkAccess"}].
        let src = b"import { checkAccess as ca } from \"./access\";\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let aliases = import_alias_lists(&out.records);
        assert!(
            aliases.iter().any(|(_, a)| a.as_deref()
                == Some(
                    &[ImportAlias {
                        local: "ca".to_string(),
                        imported: "checkAccess".to_string(),
                    }][..]
                )),
            "aliased import must carry {{local:ca, imported:checkAccess}}: {aliases:?}"
        );
    }

    #[test]
    fn non_aliased_imports_omit_import_aliases() {
        // Plain named, default, and namespace imports introduce NO alias → the
        // `import_aliases` field is omitted (None) so the common case is
        // byte-identical with older payloads.
        let src = b"import { foo } from \"a\";\nimport Bar from \"b\";\nimport * as ns from \"c\";\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let aliases = import_alias_lists(&out.records);
        assert!(
            aliases.iter().all(|(_, a)| a.is_none()),
            "non-aliased imports must omit import_aliases: {aliases:?}"
        );
        // And the wire line must not carry an `import_aliases` key.
        let line = out
            .records
            .iter()
            .find_map(|r| match r {
                Record::Edge { dst_name, kind, .. }
                    if kind == "import" && dst_name == "a" =>
                {
                    Some(serde_json::to_string(r).unwrap())
                }
                _ => None,
            })
            .expect("import edge");
        assert!(
            !line.contains("import_aliases"),
            "non-aliased import must omit `import_aliases` on the wire: {line}"
        );
    }

    #[test]
    fn mixed_named_import_carries_only_the_aliased_pair() {
        // `import { a, b as bb } from "x"` → local ["a","bb"], aliases only [bb→b].
        let src = b"import { a, b as bb } from \"x\";\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let aliases = import_alias_lists(&out.records);
        assert!(
            aliases.iter().any(|(_, a)| a.as_deref()
                == Some(
                    &[ImportAlias {
                        local: "bb".to_string(),
                        imported: "b".to_string(),
                    }][..]
                )),
            "only the aliased binding `b as bb` should appear: {aliases:?}"
        );
    }

    #[test]
    fn default_and_namespace_imports_emit_local() {
        // default `import Foo from "x"` → ["Foo"]; `import * as ns` → ["ns"].
        let src = b"import Foo from \"a\";\nimport * as ns from \"b\";\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let imports = import_locals(&out.records);
        assert!(
            imports
                .iter()
                .any(|(d, l)| d == "a" && l.as_deref() == Some(&["Foo".to_string()][..])),
            "default import → [Foo]: {imports:?}"
        );
        assert!(
            imports
                .iter()
                .any(|(d, l)| d == "b" && l.as_deref() == Some(&["ns".to_string()][..])),
            "namespace import → [ns]: {imports:?}"
        );
    }

    #[test]
    fn default_plus_named_import_emits_all_locals() {
        // `import Foo, { a, b } from "x"` → ["Foo","a","b"].
        let src = b"import Foo, { a, b } from \"x\";\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let imports = import_locals(&out.records);
        assert!(
            imports.iter().any(|(_, l)| l.as_deref()
                == Some(&["Foo".to_string(), "a".to_string(), "b".to_string()][..])),
            "default+named import → [Foo, a, b]: {imports:?}"
        );
    }

    #[test]
    fn side_effect_import_omits_local() {
        // `import "x"` introduces no binding → no `local` field on the wire.
        let src = b"import \"./styles.css\";\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let imports = import_locals(&out.records);
        assert!(
            imports.iter().any(|(d, l)| d == "./styles.css" && l.is_none()),
            "side-effect import must omit local: {imports:?}"
        );
        let line = out
            .records
            .iter()
            .find_map(|r| match r {
                Record::Edge { kind, .. } if kind == "import" => {
                    Some(serde_json::to_string(r).unwrap())
                }
                _ => None,
            })
            .expect("import edge");
        assert!(
            !line.contains("local"),
            "side-effect import edge must omit `local` on the wire: {line}"
        );
    }

    #[test]
    fn js_named_imports_emit_local_bindings() {
        // JavaScript path (separate query) must also extract bindings.
        let src = b"import { a, b as c } from \"mod\";\n";
        let out = extract_file("m.js", src, Language::JavaScript).expect("extract");
        let imports = import_locals(&out.records);
        assert!(
            imports.iter().any(|(d, l)| d == "mod"
                && l.as_deref() == Some(&["a".to_string(), "c".to_string()][..])),
            "JS named import → [a, c]: {imports:?}"
        );
    }

    // ── CommonJS `require()` → import edges ─────────────────────────────────

    /// `(src_name, dst_name, local, aliases)` of one import edge.
    type ImportEdgeView = (String, String, Option<Vec<String>>, Option<Vec<ImportAlias>>);

    /// Collect an {@link ImportEdgeView} for every import edge.
    fn cjs_imports(records: &[Record]) -> Vec<ImportEdgeView> {
        records
            .iter()
            .filter_map(|r| match r {
                Record::Edge {
                    src_name,
                    dst_name,
                    kind,
                    local,
                    import_aliases,
                    ..
                } if kind == "import" => Some((
                    src_name.clone(),
                    dst_name.clone(),
                    local.clone(),
                    import_aliases.clone(),
                )),
                _ => None,
            })
            .collect()
    }

    /// True when any static_call edge targets `require` (the legacy shape a
    /// recognized require call must NOT keep).
    fn has_require_call(records: &[Record]) -> bool {
        static_calls(records).iter().any(|(d, _)| d == "require")
    }

    #[test]
    fn js_require_const_is_an_import_edge_not_a_call() {
        let src = b"const x = require('./y');\n";
        let out = extract_file("m.js", src, Language::JavaScript).expect("extract");
        let imports = cjs_imports(&out.records);
        assert_eq!(
            imports,
            vec![(
                "m".to_string(),
                "./y".to_string(),
                Some(vec!["x".to_string()]),
                None
            )],
            "const-require must emit one import edge from the module node"
        );
        assert!(
            !has_require_call(&out.records),
            "a recognized require() must not ALSO emit a static_call"
        );
    }

    #[test]
    fn js_require_destructuring_emits_locals_and_aliases() {
        let src = b"const {a, b: c} = require('./y');\n";
        let out = extract_file("m.js", src, Language::JavaScript).expect("extract");
        let imports = cjs_imports(&out.records);
        assert_eq!(imports.len(), 1, "{imports:?}");
        let (_, dst, local, aliases) = &imports[0];
        assert_eq!(dst, "./y");
        assert_eq!(local.as_deref(), Some(&["a".to_string(), "c".to_string()][..]));
        assert_eq!(
            aliases.as_deref(),
            Some(
                &[ImportAlias {
                    local: "c".to_string(),
                    imported: "b".to_string()
                }][..]
            ),
            "`b: c` must map the local alias back to the exported name"
        );
    }

    #[test]
    fn js_require_default_and_rest_patterns_bind() {
        let src = b"const {a = 1, ...rest} = require('./y');\n";
        let out = extract_file("m.js", src, Language::JavaScript).expect("extract");
        let imports = cjs_imports(&out.records);
        assert_eq!(imports.len(), 1, "{imports:?}");
        let (_, _, local, aliases) = &imports[0];
        assert_eq!(
            local.as_deref(),
            Some(&["a".to_string(), "rest".to_string()][..]),
            "defaulted + rest bindings must both surface as locals"
        );
        assert!(aliases.is_none());
    }

    #[test]
    fn js_bare_require_is_a_side_effect_import() {
        let src = b"require('./y');\n";
        let out = extract_file("m.js", src, Language::JavaScript).expect("extract");
        let imports = cjs_imports(&out.records);
        assert_eq!(
            imports,
            vec![("m".to_string(), "./y".to_string(), None, None)],
            "bare require = side-effect import, no local"
        );
        assert!(!has_require_call(&out.records));
    }

    #[test]
    fn js_require_member_binding_is_an_aliased_import() {
        // `const z = require('./y').thing` ≙ `import { thing as z } from './y'`.
        let src = b"const z = require('./y').thing;\n";
        let out = extract_file("m.js", src, Language::JavaScript).expect("extract");
        let imports = cjs_imports(&out.records);
        assert_eq!(imports.len(), 1, "{imports:?}");
        let (_, dst, local, aliases) = &imports[0];
        assert_eq!(dst, "./y");
        assert_eq!(local.as_deref(), Some(&["z".to_string()][..]));
        assert_eq!(
            aliases.as_deref(),
            Some(
                &[ImportAlias {
                    local: "z".to_string(),
                    imported: "thing".to_string()
                }][..]
            )
        );
        assert!(!has_require_call(&out.records));
    }

    #[test]
    fn js_require_member_same_name_has_no_alias() {
        let src = b"const thing = require('./y').thing;\n";
        let out = extract_file("m.js", src, Language::JavaScript).expect("extract");
        let imports = cjs_imports(&out.records);
        assert_eq!(imports.len(), 1, "{imports:?}");
        let (_, _, local, aliases) = &imports[0];
        assert_eq!(local.as_deref(), Some(&["thing".to_string()][..]));
        assert!(aliases.is_none(), "same-name member pick needs no alias pair");
    }

    #[test]
    fn js_module_exports_require_is_a_reexport_import() {
        let src = b"module.exports = require('./y');\n";
        let out = extract_file("m.js", src, Language::JavaScript).expect("extract");
        let imports = cjs_imports(&out.records);
        assert_eq!(
            imports,
            vec![("m".to_string(), "./y".to_string(), None, None)],
            "re-export style still imports './y' (no local binding)"
        );
        assert!(!has_require_call(&out.records));
    }

    #[test]
    fn js_require_call_result_binding_imports_without_local() {
        // `require('debug')('express')` binds the RESULT of calling the
        // module, not the module itself — import edge, conservatively no local.
        let src = b"var debug = require('debug')('express:app');\n";
        let out = extract_file("m.js", src, Language::JavaScript).expect("extract");
        let imports = cjs_imports(&out.records);
        assert_eq!(
            imports,
            vec![("m".to_string(), "debug".to_string(), None, None)]
        );
        assert!(!has_require_call(&out.records));
    }

    #[test]
    fn js_dynamic_require_stays_an_unresolved_call() {
        // Computed/dynamic specifiers must NOT invent import edges: they keep
        // the legacy static_call shape (`?:require` downstream). Template
        // strings are excluded too (conservative), and extra args disqualify.
        let src = b"const a = require(name);\nrequire('./' + x);\nrequire(`./t`);\nrequire('./two', extra);\n";
        let out = extract_file("m.js", src, Language::JavaScript).expect("extract");
        assert!(
            cjs_imports(&out.records).is_empty(),
            "no import edge for any dynamic/computed require"
        );
        assert!(
            has_require_call(&out.records),
            "dynamic require must still be visible as a call"
        );
    }

    #[test]
    fn js_require_dot_resolve_is_not_an_import() {
        // `require.resolve('./x')` is a member call on `require`, not a module
        // import — unchanged legacy behavior.
        let src = b"const p = require.resolve('./x');\n";
        let out = extract_file("m.js", src, Language::JavaScript).expect("extract");
        assert!(cjs_imports(&out.records).is_empty());
    }

    #[test]
    fn js_require_inside_function_attributes_to_it() {
        let src = b"function load() {\n  const x = require('./lazy');\n  return x;\n}\n";
        let out = extract_file("m.js", src, Language::JavaScript).expect("extract");
        let imports = cjs_imports(&out.records);
        assert_eq!(imports.len(), 1, "{imports:?}");
        assert_eq!(imports[0].0, "load", "nested require anchors on the enclosing definition");
        assert_eq!(imports[0].1, "./lazy");
    }

    #[test]
    fn js_cjs_export_assigned_callables_are_indexed() {
        // `exports.foo = function` / `module.exports.bar = arrow` are the CJS
        // public callable surface (express's entire lib/utils API) — indexed
        // as functions. Arbitrary member mutations (prototype patching, test
        // monkey-patching) and non-callable exports must NOT be.
        let src = b"exports.normalizeType = function(type){ return type; };\n\
module.exports.other = (x) => x;\n\
res.send = function(){};\n\
Foo.prototype.bar = function(){};\n\
this.handler = function(){};\n\
exports.methods = ['get'];\n\
exports.etag = mkGenerator({ weak: false });\n";
        let out = extract_file("lib/utils.js", src, Language::JavaScript).expect("extract");
        let qnames = node_qnames(&out.records);
        assert!(
            qnames.contains(&("normalizeType".to_string(), "function".to_string())),
            "exports.fn must be indexed: {qnames:?}"
        );
        assert!(
            qnames.contains(&("other".to_string(), "function".to_string())),
            "module.exports.fn must be indexed: {qnames:?}"
        );
        for absent in ["send", "bar", "handler", "methods", "etag"] {
            assert!(
                !qnames.iter().any(|(q, _)| q == absent),
                "`{absent}` must NOT be indexed: {qnames:?}"
            );
        }
    }

    #[test]
    fn js_calls_inside_cjs_export_attribute_to_it() {
        let src = b"exports.wrap = function(){ return inner(); };\nfunction inner(){}\n";
        let out = extract_file("m.js", src, Language::JavaScript).expect("extract");
        let calls = call_src_dst(&out.records);
        assert!(
            calls.contains(&("wrap".to_string(), "inner".to_string())),
            "call inside an exported fn must attribute to the export entity: {calls:?}"
        );
    }

    #[test]
    fn ts_cjs_export_assigned_callable_is_indexed() {
        let src = b"exports.parse = (s: string): number => s.length;\nobj.notExport = () => 1;\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let qnames = node_qnames(&out.records);
        assert!(
            qnames.contains(&("parse".to_string(), "function".to_string())),
            "{qnames:?}"
        );
        assert!(!qnames.iter().any(|(q, _)| q == "notExport"), "{qnames:?}");
    }

    #[test]
    fn ts_require_forms_match_js() {
        // The TypeScript grammar spells all the shapes identically; pin the
        // TS path (.ts/.cts) explicitly.
        let src = b"const x = require('./y');\nconst {a, b: c} = require('./z');\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let imports = cjs_imports(&out.records);
        assert_eq!(imports.len(), 2, "{imports:?}");
        assert_eq!(imports[0].2.as_deref(), Some(&["x".to_string()][..]));
        assert_eq!(
            imports[1].2.as_deref(),
            Some(&["a".to_string(), "c".to_string()][..])
        );
        assert_eq!(
            imports[1].3.as_deref(),
            Some(
                &[ImportAlias {
                    local: "c".to_string(),
                    imported: "b".to_string()
                }][..]
            )
        );
        assert!(!has_require_call(&out.records));
    }

    #[test]
    fn ts_import_equals_require_is_an_import_with_local() {
        // TS CJS-interop `import foo = require("./bar")` — an import_statement
        // whose specifier lives on the import_require_clause.
        let src = b"import foo = require('./bar');\n";
        let out = extract_file("m.ts", src, Language::TypeScript).expect("extract");
        let imports = cjs_imports(&out.records);
        assert_eq!(
            imports,
            vec![(
                "m".to_string(),
                "./bar".to_string(),
                Some(vec!["foo".to_string()]),
                None
            )]
        );
        assert!(!has_require_call(&out.records));
    }

    #[test]
    fn non_js_import_omits_local() {
        // Python imports are not in the priority set: no `local` field.
        let src = b"import os\nfrom sys import argv\n";
        let out = extract_file("m.py", src, Language::Python).expect("extract");
        let imports = import_locals(&out.records);
        assert!(!imports.is_empty(), "python imports must still emit: {imports:?}");
        assert!(
            imports.iter().all(|(_, l)| l.is_none()),
            "non-priority langs must omit local: {imports:?}"
        );
    }

    // ── Astro frontmatter extraction ────────────────────────────────────────

    /// Collect `(name, kind, [start, end])` for every non-module Node.
    fn node_ranges(records: &[Record]) -> Vec<(String, String, [usize; 2])> {
        records
            .iter()
            .filter_map(|r| match r {
                Record::Node {
                    name, kind, range, ..
                } if kind != "module" => Some((name.clone(), kind.clone(), *range)),
                _ => None,
            })
            .collect()
    }

    fn import_dsts(records: &[Record]) -> Vec<String> {
        records
            .iter()
            .filter_map(|r| match r {
                Record::Edge {
                    dst_name, kind, ..
                } if kind == "import" => Some(dst_name.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn astro_frontmatter_imports_are_extracted_from_the_module() {
        // The `---…---` block is TypeScript: its imports must surface as edges
        // anchored on the synthetic module node (the file stem).
        let src = b"---\nimport Base from \"~/layouts/Base.astro\";\nimport Stats from \"~/components/Stats.tsx\";\n---\n<Base><Stats /></Base>\n";
        let out = extract_file("viewer/src/pages/index.astro", src, Language::Astro)
            .expect("extract astro");
        let dsts = import_dsts(&out.records);
        assert!(
            dsts.iter().any(|d| d == "~/layouts/Base.astro"),
            "Base import must be an edge: {dsts:?}"
        );
        assert!(
            dsts.iter().any(|d| d == "~/components/Stats.tsx"),
            "Stats import must be an edge: {dsts:?}"
        );
        // The module node carries the file stem.
        assert!(out.records.iter().any(
            |r| matches!(r, Record::Node { name, kind, .. } if name == "index" && kind == "module")
        ));
    }

    #[test]
    fn astro_frontmatter_ranges_are_offset_to_the_real_file() {
        // `interface Props` sits on file lines 4–6 (after the opening fence on
        // line 1 and a leading comment on line 2). The emitted range MUST be the
        // real-file lines, not frontmatter-relative ones.
        let src = b"---\n// header comment\ninterface Props {\n  title: string;\n}\nconst x = 1;\n---\n<html></html>\n";
        let out = extract_file("Base.astro", src, Language::Astro).expect("extract astro");
        let ranges = node_ranges(&out.records);
        let props = ranges
            .iter()
            .find(|(n, _, _)| n == "Props")
            .unwrap_or_else(|| panic!("Props interface must be indexed: {ranges:?}"));
        assert_eq!(
            props.2,
            [3, 5],
            "Props range must map to real file lines 3..=5 (frontmatter offset applied): {ranges:?}"
        );
    }

    #[test]
    fn astro_module_node_spans_the_whole_file_not_just_frontmatter() {
        // The module node's range/hash represent the entire file, so an edit to
        // the template below the fence still changes the module's ast_hash.
        let src = b"---\nconst y = 2;\n---\n<div>\n  <p>line</p>\n</div>\n";
        let out = extract_file("page.astro", src, Language::Astro).expect("extract astro");
        let module = out
            .records
            .iter()
            .find_map(|r| match r {
                Record::Node { kind, range, .. } if kind == "module" => Some(*range),
                _ => None,
            })
            .expect("module node");
        assert_eq!(
            module[0], 1,
            "module starts at line 1: {module:?}"
        );
        assert!(
            module[1] >= 6,
            "module must span past the closing fence into the template: {module:?}"
        );
    }

    #[test]
    fn astro_without_frontmatter_still_emits_a_module_node() {
        // A template-only `.astro` page (no `---` block) is still a navigable
        // entity — we emit just the module node and never panic.
        let src = b"<html>\n  <body>no frontmatter</body>\n</html>\n";
        let out = extract_file("plain.astro", src, Language::Astro).expect("extract astro");
        assert!(
            out.records.iter().any(|r| matches!(
                r,
                Record::Node { name, kind, .. } if name == "plain" && kind == "module"
            )),
            "module node must still be emitted: {:?}",
            out.records
        );
        // No spurious symbols from the template.
        assert!(
            node_ranges(&out.records).is_empty(),
            "template-only file must yield no symbols: {:?}",
            node_ranges(&out.records)
        );
    }

    #[test]
    fn astro_frontmatter_helper_slices_correctly() {
        // Direct unit test of the slicer: offset is the content's 0-based line.
        let src = b"---\nconst a = 1;\nconst b = 2;\n---\n<p/>\n";
        let (slice, offset) = astro_frontmatter(src).expect("frontmatter present");
        assert_eq!(offset, 1, "content starts on line index 1 (file line 2)");
        assert_eq!(
            std::str::from_utf8(slice).unwrap(),
            "const a = 1;\nconst b = 2;\n"
        );
        // Leading blank lines before the fence are tolerated.
        let src2 = b"\n\n---\nconst c = 3;\n---\n";
        let (slice2, offset2) = astro_frontmatter(src2).expect("frontmatter present");
        assert_eq!(offset2, 3, "content starts on line index 3 after two blanks");
        assert_eq!(std::str::from_utf8(slice2).unwrap(), "const c = 3;\n");
        // No fence → None.
        assert!(astro_frontmatter(b"<div>only template</div>\n").is_none());
        // Unterminated fence → None.
        assert!(astro_frontmatter(b"---\nconst d = 4;\n").is_none());
    }
}

