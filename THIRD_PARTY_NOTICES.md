# Third-Party Notices

This project contains code adapted from the upstream project
[oh-my-pi](https://github.com/can1357/oh-my-pi).

Scope of ported upstream code:

- from **oh-my-pi** (MIT, notice below): the tool suite sources under
  `src/tools/` (bash runtime, read, write, edit, grep, glob, plus the OMP
  `omp/` engine sources they wrap), and the thin hashline adapter at
  `src/tools/hashline/native/` (`diff-preview.ts` is a verbatim port of the
  former upstream TypeScript engine). The hashline engine itself is no longer
  vendored: since oh-my-pi 18.x it lives in Rust (`crates/pi-edit`) and reaches
  this plugin through the `@oh-my-pi/pi-natives` dependency, which ships
  upstream's compiled binary.
- upstream hashline **test fixtures** vendored for regression testing under
  `src/tools/hashline/test/fixtures/` (copied from
  `crates/pi-edit/tests/fixtures/hashline/`), MIT, same notice below.

---

oh-my-pi - MIT

-- License

(The MIT License)

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

