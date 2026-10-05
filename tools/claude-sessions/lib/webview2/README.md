# WebView2 for AutoHotkey (vendored)

Unmodified third-party files that let Switchboard host a WebView2 control.
**Do not edit them.** To update, replace them from the sources below and update this file.

The layout mirrors thqby's repo, because `WebView2/WebView2.ahk` includes
`..\ComVar.ahk` and `..\Promise.ahk`.

| File | Source | Version | Licence |
|---|---|---|---|
| `WebView2/WebView2.ahk` | github.com/thqby/ahk2_lib, `WebView2/WebView2.ahk` | v2.0.5 (2025/04/29), commit `06aed7a1c42f754dfcb67962d055311a480d0848` | MIT, `LICENSE` |
| `ComVar.ahk`, `Promise.ahk` | github.com/thqby/ahk2_lib, the same commit | — | MIT, `LICENSE` |
| `WebView2/64bit/WebView2Loader.dll` | NuGet `Microsoft.Web.WebView2` 1.0.2903.40, `build/native/x64/` | 1.0.2903.40 | Microsoft BSD-style, `WebView2/64bit/LICENSE-WebView2Loader.txt` |

**The DLL.** SHA-256 `462B36FD1BE6CA9F7563466A89E57C41EF4A4DEF3E0A84FA885D203AEA4A3AAF`, Authenticode-signed by Microsoft Corporation. It matches the WebView2 SDK version the library was written for. The WebView2 runtime itself ships with Windows 11.

**The 64-bit DLL only.** Switchboard runs on `AutoHotkey64.exe`.

**The font** is vendored separately, in `ui/fonts/`: Atkinson Hyperlegible Regular and Bold TTFs, from github.com/google/fonts `ofl/atkinsonhyperlegible`, under the SIL Open Font License (`ui/fonts/OFL.txt`).
