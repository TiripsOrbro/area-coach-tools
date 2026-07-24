// Area Coach Tools — single entrypoint (.exe).
// Fresh folder: shows install UI and bootstraps from GitHub into this folder.
// Already installed: quiet Git update, then launches the Electron app.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal sealed class SetupForm : Form
{
    private static readonly string Ps1RawUrl =
        "https://raw.githubusercontent.com/TiripsOrbro/area-coach-tools/main/Install-AreaCoachTools.ps1";

    private readonly string _installDir;
    private readonly bool _autoStart;
    private readonly TextBox _log;
    private readonly Label _folderLabel;
    private readonly Button _installBtn;
    private readonly Button _closeBtn;
    private readonly ProgressBar _bar;
    private Process _child;
    private bool _busy;

    public SetupForm(string installDir, bool autoStart)
    {
        _installDir = installDir;
        _autoStart = autoStart;
        Text = "Area Coach Tools";
        Width = 640;
        Height = 480;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = true;
        BackColor = Color.FromArgb(20, 16, 28);
        ForeColor = Color.FromArgb(246, 241, 255);
        Font = new Font("Segoe UI", 9.5f);
        try
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch
        {
            /* default icon */
        }

        var title = new Label
        {
            Text = "Area Coach Tools",
            Left = 20,
            Top = 18,
            Width = 580,
            Height = 32,
            Font = new Font("Segoe UI Semibold", 16f),
            ForeColor = Color.FromArgb(216, 180, 254),
        };

        var blurb = new Label
        {
            Text =
                "Installs Git/Node if needed, downloads updates into this folder, then launches the app.",
            Left = 20,
            Top = 54,
            Width = 580,
            Height = 36,
            ForeColor = Color.FromArgb(200, 190, 220),
        };

        _folderLabel = new Label
        {
            Text = "Folder:\n" + _installDir,
            Left = 20,
            Top = 96,
            Width = 580,
            Height = 40,
            ForeColor = Color.White,
        };

        _bar = new ProgressBar
        {
            Left = 20,
            Top = 146,
            Width = 580,
            Height = 18,
            Style = ProgressBarStyle.Marquee,
            MarqueeAnimationSpeed = 30,
            Visible = false,
        };

        _log = new TextBox
        {
            Left = 20,
            Top = 176,
            Width = 580,
            Height = 200,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            BackColor = Color.FromArgb(12, 10, 18),
            ForeColor = Color.FromArgb(220, 210, 240),
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Consolas", 9f),
        };

        _installBtn = new Button
        {
            Text = "Install / Update",
            Left = 20,
            Top = 392,
            Width = 160,
            Height = 34,
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(88, 28, 135),
            ForeColor = Color.White,
        };
        _installBtn.FlatAppearance.BorderColor = Color.FromArgb(192, 132, 252);
        _installBtn.Click += (_, __) => StartInstall(launchWhenDone: true);

        _closeBtn = new Button
        {
            Text = "Close",
            Left = 190,
            Top = 392,
            Width = 100,
            Height = 34,
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(40, 32, 55),
            ForeColor = Color.White,
        };
        _closeBtn.Click += (_, __) =>
        {
            if (_busy)
            {
                MessageBox.Show(
                    this,
                    "Install is still running. Wait for it to finish.",
                    Text,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                return;
            }
            Close();
        };

        Controls.Add(title);
        Controls.Add(blurb);
        Controls.Add(_folderLabel);
        Controls.Add(_bar);
        Controls.Add(_log);
        Controls.Add(_installBtn);
        Controls.Add(_closeBtn);

        AppendLog("Ready.");
        AppendLog("Missing Git/Node will be installed automatically when possible.");
        if (_autoStart)
        {
            AppendLog(Program.AppLooksInstalled(_installDir)
                ? "Checking for updates, then launching..."
                : "Starting install...");
            Load += (_, __) => BeginInvoke(new Action(() => StartInstall(launchWhenDone: true)));
        }
        else
        {
            AppendLog("Click Install / Update to download or refresh the app in this folder.");
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (_busy)
        {
            e.Cancel = true;
            MessageBox.Show(
                this,
                "Install is still running. Wait for it to finish.",
                Text,
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
            return;
        }
        base.OnFormClosing(e);
    }

    private void AppendLog(string line)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action<string>(AppendLog), line);
            return;
        }
        _log.AppendText(line.TrimEnd() + Environment.NewLine);
    }

    private void SetBusy(bool busy)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action<bool>(SetBusy), busy);
            return;
        }
        _busy = busy;
        _installBtn.Enabled = !busy;
        _bar.Visible = busy;
    }

    private string EnsureInstallerScript()
    {
        string local = Path.Combine(_installDir, "Install-AreaCoachTools.ps1");
        if (File.Exists(local)) return local;

        AppendLog("Downloading installer script from GitHub...");
        string temp = Path.Combine(Path.GetTempPath(), "Install-AreaCoachTools.ps1");
        using (var wc = new WebClient())
        {
            ServicePointManager.SecurityProtocol =
                SecurityProtocolType.Tls12 | SecurityProtocolType.Tls11 | SecurityProtocolType.Tls;
            wc.Encoding = Encoding.UTF8;
            wc.DownloadFile(Ps1RawUrl, temp);
        }
        try
        {
            File.Copy(temp, local, true);
            return local;
        }
        catch
        {
            return temp;
        }
    }

    private void StartInstall(bool launchWhenDone)
    {
        if (_busy) return;

        SetBusy(true);
        AppendLog("==== Install started ====");
        AppendLog("Folder: " + _installDir);

        ThreadPool.QueueUserWorkItem(_ =>
        {
            int code = 1;
            try
            {
                Directory.CreateDirectory(_installDir);
                string ps1 = EnsureInstallerScript();
                AppendLog("Using: " + ps1);

                // -WindowStyle Hidden as belt-and-suspenders; CreateNoWindow hides the console.
                string args =
                    "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \""
                    + ps1
                    + "\" -InstallDir \""
                    + _installDir
                    + "\" -Quiet"
                    + (launchWhenDone ? " -Launch" : " -NoLaunch")
                    + " -Bootstrap";

                var psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = args,
                    WorkingDirectory = _installDir,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                };

                using (var p = new Process { StartInfo = psi, EnableRaisingEvents = true })
                {
                    _child = p;
                    p.OutputDataReceived += (s, e) =>
                    {
                        if (!string.IsNullOrEmpty(e.Data)) AppendLog(e.Data);
                    };
                    p.ErrorDataReceived += (s, e) =>
                    {
                        if (!string.IsNullOrEmpty(e.Data)) AppendLog(e.Data);
                    };
                    p.Start();
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    p.WaitForExit();
                    code = p.ExitCode;
                    _child = null;
                }
            }
            catch (Exception ex)
            {
                AppendLog("ERROR: " + ex.Message);
                code = 1;
            }

            SetBusy(false);
            if (code == 0)
            {
                AppendLog("==== Install finished ====");
                BeginInvoke(
                    new Action(() =>
                    {
                        // App should already be launching via -Launch; close the bootstrap UI.
                        Close();
                    })
                );
            }
            else
            {
                AppendLog("==== Install failed (exit " + code + ") ====");
                BeginInvoke(
                    new Action(() =>
                    {
                        MessageBox.Show(
                            this,
                            "Install/update failed. Check the log in this window for the real error.\n\n"
                                + "Common causes: no internet, GitHub blocked, or npm install failed.\n"
                                + "Git and Node.js 18+ are required (the installer tries to install them).",
                            Text,
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Error
                        );
                    })
                );
            }
        });
    }
}

internal static class Program
{
    internal static bool AppLooksInstalled(string dir)
    {
        return File.Exists(Path.Combine(dir, "package.json"))
            && File.Exists(Path.Combine(dir, "Install-AreaCoachTools.ps1"))
            && Directory.Exists(Path.Combine(dir, "desktop"));
    }

    private static bool HasFlag(string[] args, params string[] names)
    {
        foreach (var a in args)
        {
            foreach (var n in names)
            {
                if (string.Equals(a, n, StringComparison.OrdinalIgnoreCase)) return true;
            }
        }
        return false;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string installDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar
        );

        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], "/dir", StringComparison.OrdinalIgnoreCase)
                || string.Equals(args[i], "-InstallDir", StringComparison.OrdinalIgnoreCase))
            {
                installDir = Path.GetFullPath(args[i + 1].Trim().Trim('"'));
            }
        }

        // /ui = show window and wait for the button; otherwise auto update/install then launch.
        // PowerShell/npm always run hidden; progress streams into this window.
        bool waitForClick = HasFlag(args, "/ui", "--ui");
        Application.Run(new SetupForm(installDir, autoStart: !waitForClick));
        return 0;
    }
}
