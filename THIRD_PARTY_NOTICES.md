# Third-Party Notices

This project contains code adapted from two upstream projects:
[oh-my-pi](https://github.com/can1357/oh-my-pi) and the official DeepSeek
Harness tool packages ([@deepseek-ai/dsh-tool-fs](https://www.npmjs.com/package/@deepseek-ai/dsh-tool-fs)).

Scope of ported upstream code:

- from **oh-my-pi** (MIT, first notice below): the tool suite sources under
  `src/tools/` (bash runtime, read, write, edit, grep, glob, plus the OMP
  `omp/` engine sources they wrap), and the hashline patch engine fused
  in-repo at `src/tools/hashline/engine/` (upstream `packages/hashline`,
  with small Node-runtime adaptations);
- from **`@deepseek-ai/dsh-tool-fs`** (MIT, second notice below): the
  `read_image` image tool at `src/tools/read-image/`, ported from the
  official read-image implementation to keep the tool surface identical.

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

---

@deepseek-ai/dsh-tool-fs (read_image portion) - MIT

-- License

(The MIT License)

Copyright (c) 2026 DeepSeek

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
