// ExportDecompiled.java - Ghidra headless script.
// Saves every function as a separate .c file, grouped into folders by namespace/class,
// plus one combined file _ALL.c.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.Namespace;
import java.io.*;

public class ExportDecompiled extends GhidraScript {
    private static String clean(String s) {
        String r = s.replaceAll("[^A-Za-z0-9_\\-]", "_");
        return r.length() > 80 ? r.substring(0, 80) : r;
    }

    @Override
    public void run() throws Exception {
        File root = new File(getScriptArgs()[0]);
        root.mkdirs();
        DecompInterface d = new DecompInterface();
        d.openProgram(currentProgram);
        try (PrintWriter all = new PrintWriter(new OutputStreamWriter(
                new FileOutputStream(new File(root, "_ALL.c")), "UTF-8"))) {
            for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
                if (monitor.isCancelled()) break;
                if (f.isExternal() || f.isThunk()) continue;
                DecompileResults r = d.decompileFunction(f, 60, monitor);
                if (r == null || r.getDecompiledFunction() == null) continue;
                String code = r.getDecompiledFunction().getC();

                // folder = namespace path (C++ class / Go package / Rust module)
                File dir = new File(root, "functions");
                Namespace ns = f.getParentNamespace();
                java.util.ArrayList<String> parts = new java.util.ArrayList<>();
                while (ns != null && !ns.isGlobal()) {
                    parts.add(0, clean(ns.getName()));
                    ns = ns.getParentNamespace();
                }
                for (String p : parts) dir = new File(dir, p);
                dir.mkdirs();

                String name = clean(f.getName()) + "_" + f.getEntryPoint().toString() + ".c";
                try (PrintWriter w = new PrintWriter(new OutputStreamWriter(
                        new FileOutputStream(new File(dir, name)), "UTF-8"))) {
                    w.print(code);
                }
                all.println("// ===== " + f.getName(true) + " @ " + f.getEntryPoint() + " =====");
                all.println(code);
            }
        }
        d.dispose();
    }
}
