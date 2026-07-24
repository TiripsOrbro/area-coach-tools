// Thin Windows launcher for Area Coach Tools.
// Built at install time with csc.exe. On open: Git update (if needed) then start Electron.
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar
            );
            string ps1 = Path.Combine(root, "Install-AreaCoachTools.ps1");
            if (!File.Exists(ps1))
            {
                MessageBox.Show(
                    "Install-AreaCoachTools.ps1 was not found next to this .exe.\n\nRe-run the installer.",
                    "Area Coach Tools",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return 1;
            }

            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments =
                    "-NoProfile -ExecutionPolicy Bypass -File \""
                    + ps1
                    + "\" -InstallDir \""
                    + root
                    + "\" -Quiet -Launch",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = false,
            };

            using (Process p = Process.Start(psi))
            {
                if (p == null)
                {
                    MessageBox.Show(
                        "Could not start PowerShell to update/launch the app.",
                        "Area Coach Tools",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                    return 1;
                }
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                ex.Message,
                "Area Coach Tools",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return 1;
        }
    }
}
