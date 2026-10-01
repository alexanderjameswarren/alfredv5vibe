; Reads a Chrome window's address bar through UI Automation, with raw COM calls
; (no library). Returns "" on any failure, so a caller can always carry on.

ReadChromeAddress(hwnd) {
    static UIA_ControlTypePropertyId := 30003, UIA_EditControlTypeId := 50004
    static UIA_ValueValuePropertyId := 30045, TreeScope_Descendants := 4
    uia := 0, root := 0, cond := 0, omnibox := 0, value := ""   ; not `edit`: Edit() is built in
    try {
        uia := ComObject("{ff48dba4-60ef-4201-aa87-54103eef594e}", "{30cbe57d-d9d0-452a-ab13-7ac5ac4825ee}")
        ComCall(6, uia, "ptr", hwnd, "ptr*", &root)                       ; ElementFromHandle
        v := Buffer(24, 0)
        NumPut("ushort", 3, v, 0), NumPut("int", UIA_EditControlTypeId, v, 8)   ; VT_I4
        ComCall(23, uia, "int", UIA_ControlTypePropertyId, "ptr", v, "ptr*", &cond)  ; CreatePropertyCondition
        ComCall(5, root, "int", TreeScope_Descendants, "ptr", cond, "ptr*", &omnibox)   ; FindFirst
        if omnibox {
            out := Buffer(24, 0)
            ComCall(10, omnibox, "int", UIA_ValueValuePropertyId, "ptr", out)      ; GetCurrentPropertyValue
            if NumGet(out, 0, "ushort") = 8                                    ; VT_BSTR
                value := StrGet(NumGet(out, 8, "ptr"))
            DllCall("OleAut32\VariantClear", "ptr", out)
        }
    }
    for p in [omnibox, cond, root]
        if p
            ObjRelease(p)
    return value
}
