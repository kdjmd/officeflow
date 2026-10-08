using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using Accessibility;

internal static class DragMonitor
{
    private enum ShellItemMatch
    {
        NoMatch,
        OrdinaryFile,
        NonFile
    }

    private const int WmNcHitTest = 0x0084;
    private const int HtClient = 1;
    private const int VkLButton = 0x01;
    private const int VkRButton = 0x02;
    private const int SmSwapButton = 23;
    private const int RoleSystemListItem = 0x22;
    private const uint GaRoot = 2;
    private const uint SmtoAbortIfHung = 0x0002;
    private const int DragThresholdPixels = 12;
    private const int IdlePollIntervalMs = 15;
    private const int DragPollIntervalMs = 8;

    private static readonly object StateLock = new object();
    private static TextWriter output;
    private static bool leftButtonDown;
    private static bool explorerDragCandidate;
    private static bool fileItemCandidate;
    private static bool classificationComplete;
    private static bool dragThresholdReached;
    private static bool dragAnnounced;
    private static bool debugEnabled;
    private static bool debugMoveSeen;
    private static int primaryButtonVirtualKey;
    private static int pointerSequenceId;
    private static Point dragOrigin;

    public static int Main(string[] args)
    {
        output = TextWriter.Synchronized(
            new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
        debugEnabled = Array.Exists(args, delegate(string arg)
        {
            return arg.Equals("--debug", StringComparison.OrdinalIgnoreCase);
        });

        int parentPid;
        if (args.Length > 0 && int.TryParse(args[0], out parentPid)) StartParentWatcher(parentPid);

        NativeMethods.SetProcessDPIAware();
        primaryButtonVirtualKey = NativeMethods.GetSystemMetrics(SmSwapButton) != 0 ? VkRButton : VkLButton;
        output.WriteLine("ready");
        RunPointerLoop();
        return 0;
    }

    private static void RunPointerLoop()
    {
        bool wasButtonDown = IsPrimaryButtonDown();
        Point cursorPoint;
        NativeMethods.GetCursorPos(out cursorPoint);

        while (true)
        {
            bool isButtonDown = IsPrimaryButtonDown();
            if (!NativeMethods.GetCursorPos(out cursorPoint))
            {
                Thread.Sleep(isButtonDown ? DragPollIntervalMs : IdlePollIntervalMs);
                continue;
            }

            if (isButtonDown && !wasButtonDown)
            {
                BeginPointerSequence(cursorPoint);
            }
            else if (isButtonDown)
            {
                UpdatePointerSequence(cursorPoint);
            }
            else if (wasButtonDown)
            {
                EndPointerSequence();
            }

            wasButtonDown = isButtonDown;
            Thread.Sleep(isButtonDown ? DragPollIntervalMs : IdlePollIntervalMs);
        }
    }

    private static bool IsPrimaryButtonDown()
    {
        return (NativeMethods.GetAsyncKeyState(primaryButtonVirtualKey) & 0x8000) != 0;
    }

    private static void BeginPointerSequence(Point point)
    {
        long candidateCheckStarted = Stopwatch.GetTimestamp();
        int explorerProcessId;
        IntPtr explorerRootWindow;
        bool isExplorerClient = TryGetExplorerClientProcess(point, out explorerProcessId, out explorerRootWindow);
        double candidateCheckMilliseconds =
            (Stopwatch.GetTimestamp() - candidateCheckStarted) * 1000.0 / Stopwatch.Frequency;
        int sequenceId;

        lock (StateLock)
        {
            sequenceId = unchecked(++pointerSequenceId);
            leftButtonDown = true;
            dragAnnounced = false;
            debugMoveSeen = false;
            dragThresholdReached = false;
            fileItemCandidate = false;
            classificationComplete = !isExplorerClient;
            dragOrigin = point;
            explorerDragCandidate = isExplorerClient;
            if (debugEnabled)
            {
                output.WriteLine("debug:down:" + isExplorerClient + ":" + point.x + "," + point.y +
                    ":ms=" + candidateCheckMilliseconds.ToString("F1"));
            }
        }

        if (!isExplorerClient) return;

        ThreadPool.QueueUserWorkItem(delegate
        {
            ClassifyFileItem(sequenceId, point, explorerProcessId, explorerRootWindow);
        });
    }

    private static void ClassifyFileItem(int sequenceId, Point point, int explorerProcessId, IntPtr explorerRootWindow)
    {
        bool isFileItem = IsFileSystemListItemAtPoint(point, explorerProcessId, explorerRootWindow);

        lock (StateLock)
        {
            bool isCurrentSequence = sequenceId == pointerSequenceId && leftButtonDown && explorerDragCandidate &&
                IsPrimaryButtonDown();
            if (debugEnabled) output.WriteLine("debug:item:" + isFileItem);
            if (!isCurrentSequence) return;

            classificationComplete = true;
            fileItemCandidate = isFileItem;
            if (isFileItem && dragThresholdReached && !dragAnnounced)
            {
                dragAnnounced = true;
                output.WriteLine("drag-start");
            }
        }
    }

    private static void UpdatePointerSequence(Point point)
    {
        lock (StateLock)
        {
            if (!leftButtonDown || !explorerDragCandidate || dragAnnounced) return;
            int deltaX = point.x - dragOrigin.x;
            int deltaY = point.y - dragOrigin.y;
            if (debugEnabled && !debugMoveSeen)
            {
                debugMoveSeen = true;
                output.WriteLine("debug:move:" + point.x + "," + point.y + ":delta=" + deltaX + "," + deltaY);
            }
            if ((deltaX * deltaX) + (deltaY * deltaY) >= DragThresholdPixels * DragThresholdPixels)
            {
                dragThresholdReached = true;
                if (classificationComplete && fileItemCandidate)
                {
                    dragAnnounced = true;
                    output.WriteLine("drag-start");
                }
            }
        }
    }

    private static void EndPointerSequence()
    {
        lock (StateLock)
        {
            bool announceEnd = dragAnnounced;
            unchecked { pointerSequenceId++; }
            leftButtonDown = false;
            explorerDragCandidate = false;
            fileItemCandidate = false;
            classificationComplete = false;
            dragThresholdReached = false;
            dragAnnounced = false;
            if (announceEnd) output.WriteLine("drag-end");
        }
    }

    private static void StartParentWatcher(int parentPid)
    {
        Thread watcher = new Thread(delegate()
        {
            try
            {
                using (Process parent = Process.GetProcessById(parentPid)) parent.WaitForExit();
            }
            catch
            {
            }
            Environment.Exit(0);
        });
        watcher.IsBackground = true;
        watcher.Name = "OfficeFlow parent watcher";
        watcher.Start();
    }

    private static bool TryGetExplorerClientProcess(Point point, out int explorerProcessId,
        out IntPtr explorerRootWindow)
    {
        explorerProcessId = 0;
        explorerRootWindow = IntPtr.Zero;
        IntPtr window = NativeMethods.WindowFromPoint(point);
        if (window == IntPtr.Zero) return false;

        string className = GetClassName(window);
        if (className.Equals("ScrollBar", StringComparison.OrdinalIgnoreCase) ||
            className.Equals("SysHeader32", StringComparison.OrdinalIgnoreCase) ||
            className.Equals("ToolbarWindow32", StringComparison.OrdinalIgnoreCase) ||
            className.Equals("Edit", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        IntPtr root = NativeMethods.GetAncestor(window, GaRoot);
        if (root == IntPtr.Zero) root = window;

        long packedPoint = ((long)(ushort)point.x) | ((long)(ushort)point.y << 16);
        IntPtr hitTestResult;
        if (NativeMethods.SendMessageTimeout(root, WmNcHitTest, IntPtr.Zero, new IntPtr(packedPoint),
            SmtoAbortIfHung, 50, out hitTestResult) == IntPtr.Zero || hitTestResult.ToInt32() != HtClient)
        {
            return false;
        }

        uint processId;
        NativeMethods.GetWindowThreadProcessId(window, out processId);
        if (processId == 0) return false;

        try
        {
            using (Process process = Process.GetProcessById((int)processId))
            {
                if (!process.ProcessName.Equals("explorer", StringComparison.OrdinalIgnoreCase)) return false;
                explorerProcessId = (int)processId;
                explorerRootWindow = root;
                return true;
            }
        }
        catch
        {
            return false;
        }
    }

    private static bool IsFileSystemListItemAtPoint(Point point, int explorerProcessId, IntPtr explorerRootWindow)
    {
        IntPtr nativeWindow = NativeMethods.WindowFromPoint(point);
        if (nativeWindow != IntPtr.Zero &&
            GetClassName(nativeWindow).Equals("SysListView32", StringComparison.OrdinalIgnoreCase))
        {
            string desktopItemName;
            return TryGetNativeDesktopListItemAtPoint(point, explorerProcessId, out desktopItemName) &&
                IsOrdinaryDesktopFile(desktopItemName);
        }

        try
        {
            AutomationElement element = AutomationElement.FromPoint(new System.Windows.Point(point.x, point.y));
            TreeWalker walker = TreeWalker.ControlViewWalker;
            for (int depth = 0; element != null && depth < 8; depth++)
            {
                AutomationElement.AutomationElementInformation current = element.Current;
                if (current.ProcessId == explorerProcessId &&
                    current.ControlType == ControlType.ListItem &&
                    !string.IsNullOrWhiteSpace(current.Name) &&
                    !current.IsOffscreen)
                {
                    return IsOrdinaryExplorerFile(explorerRootWindow, current.Name);
                }
                element = walker.GetParent(element);
            }
        }
        catch
        {
        }
        return false;
    }

    private static bool TryGetNativeDesktopListItemAtPoint(Point point, int explorerProcessId,
        out string itemName)
    {
        itemName = null;
        IntPtr window = NativeMethods.WindowFromPoint(point);
        if (window == IntPtr.Zero || !GetClassName(window).Equals("SysListView32", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        uint processId;
        NativeMethods.GetWindowThreadProcessId(window, out processId);
        if (processId != (uint)explorerProcessId) return false;

        IAccessible accessible = null;
        try
        {
            Guid interfaceId = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
            if (NativeMethods.AccessibleObjectFromWindow(window, unchecked((uint)-4), ref interfaceId, out accessible) != 0 ||
                accessible == null)
            {
                return false;
            }

            object hit = accessible.accHitTest(point.x, point.y);
            if (hit is int)
            {
                int childId = (int)hit;
                if (childId <= 0) return false;
                int role = Convert.ToInt32(accessible.get_accRole(childId));
                string name = accessible.get_accName(childId);
                if (role != RoleSystemListItem || string.IsNullOrWhiteSpace(name)) return false;
                itemName = name;
                return true;
            }

            IAccessible child = hit as IAccessible;
            if (child == null) return false;
            try
            {
                int role = Convert.ToInt32(child.get_accRole(0));
                string name = child.get_accName(0);
                if (role != RoleSystemListItem || string.IsNullOrWhiteSpace(name)) return false;
                itemName = name;
                return true;
            }
            finally
            {
                if (!ReferenceEquals(child, accessible) && Marshal.IsComObject(child)) Marshal.FinalReleaseComObject(child);
            }
        }
        catch
        {
            return false;
        }
        finally
        {
            if (accessible != null && Marshal.IsComObject(accessible)) Marshal.FinalReleaseComObject(accessible);
        }
    }

    private static bool IsOrdinaryExplorerFile(IntPtr explorerRootWindow, string itemName)
    {
        if (explorerRootWindow == IntPtr.Zero || string.IsNullOrWhiteSpace(itemName)) return false;

        object shell = null;
        object shellWindows = null;
        object matchingWindow = null;
        object document = null;
        object folder = null;
        try
        {
            shell = CreateShellApplication();
            if (shell == null) return false;
            shellWindows = InvokeComMethod(shell, "Windows");
            int windowCount = GetComIntProperty(shellWindows, "Count");
            for (int index = 0; index < windowCount; index++)
            {
                object candidateWindow = null;
                try
                {
                    candidateWindow = InvokeComMethod(shellWindows, "Item", index);
                    long candidateHandle = GetComLongProperty(candidateWindow, "HWND");
                    if (new IntPtr(candidateHandle) != explorerRootWindow) continue;

                    matchingWindow = candidateWindow;
                    candidateWindow = null;
                    break;
                }
                finally
                {
                    ReleaseComObject(candidateWindow);
                }
            }

            if (matchingWindow == null) return false;
            document = GetComProperty(matchingWindow, "Document");
            folder = GetComProperty(document, "Folder");
            return IsOrdinaryFileInShellFolder(folder, document, itemName);
        }
        catch
        {
            return false;
        }
        finally
        {
            ReleaseComObject(folder);
            ReleaseComObject(document);
            ReleaseComObject(matchingWindow);
            ReleaseComObject(shellWindows);
            ReleaseComObject(shell);
        }
    }

    private static bool IsOrdinaryDesktopFile(string itemName)
    {
        if (string.IsNullOrWhiteSpace(itemName)) return false;

        object shell = null;
        object desktopFolder = null;
        try
        {
            shell = CreateShellApplication();
            if (shell == null) return false;
            desktopFolder = InvokeComMethod(shell, "NameSpace", 0);
            return IsOrdinaryFileInShellFolder(desktopFolder, null, itemName);
        }
        catch
        {
            return false;
        }
        finally
        {
            ReleaseComObject(desktopFolder);
            ReleaseComObject(shell);
        }
    }

    private static bool IsOrdinaryFileInShellFolder(object folder, object document, string itemName)
    {
        if (folder == null) return false;

        object folderItem = null;
        object folderItems = null;
        try
        {
            if (document != null)
            {
                folderItem = TryGetComProperty(document, "FocusedItem");
                ShellItemMatch focusedMatch = EvaluateShellItem(folderItem, itemName);
                if (focusedMatch != ShellItemMatch.NoMatch) return focusedMatch == ShellItemMatch.OrdinaryFile;
                ReleaseComObject(folderItem);
                folderItem = null;
            }

            folderItem = InvokeComMethod(folder, "ParseName", itemName);
            ShellItemMatch parsedMatch = EvaluateShellItem(folderItem, itemName);
            if (parsedMatch != ShellItemMatch.NoMatch) return parsedMatch == ShellItemMatch.OrdinaryFile;
            ReleaseComObject(folderItem);
            folderItem = null;

            // Explorer may hide a known extension (and always hides .lnk), in which case
            // ParseName cannot resolve the displayed name. Enumeration is a last-resort
            // path used only after the focused/direct lookups fail.
            folderItems = InvokeComMethod(folder, "Items");
            int itemCount = GetComIntProperty(folderItems, "Count");
            for (int index = 0; index < itemCount; index++)
            {
                folderItem = InvokeComMethod(folderItems, "Item", index);
                ShellItemMatch enumeratedMatch = EvaluateShellItem(folderItem, itemName);
                if (enumeratedMatch != ShellItemMatch.NoMatch)
                {
                    return enumeratedMatch == ShellItemMatch.OrdinaryFile;
                }
                ReleaseComObject(folderItem);
                folderItem = null;
            }
        }
        catch
        {
            return false;
        }
        finally
        {
            ReleaseComObject(folderItem);
            ReleaseComObject(folderItems);
        }

        return false;
    }

    private static ShellItemMatch EvaluateShellItem(object folderItem, string expectedName)
    {
        if (folderItem == null) return ShellItemMatch.NoMatch;
        string actualName = Convert.ToString(GetComProperty(folderItem, "Name"));
        if (!string.Equals(actualName, expectedName, StringComparison.OrdinalIgnoreCase))
        {
            return ShellItemMatch.NoMatch;
        }
        string path = Convert.ToString(GetComProperty(folderItem, "Path"));
        return !string.IsNullOrWhiteSpace(path) && File.Exists(path)
            ? ShellItemMatch.OrdinaryFile
            : ShellItemMatch.NonFile;
    }

    private static object CreateShellApplication()
    {
        Type shellType = Type.GetTypeFromProgID("Shell.Application", false);
        return shellType == null ? null : Activator.CreateInstance(shellType);
    }

    private static object GetComProperty(object target, string propertyName)
    {
        if (target == null) return null;
        return target.GetType().InvokeMember(propertyName, BindingFlags.GetProperty, null, target, null);
    }

    private static object TryGetComProperty(object target, string propertyName)
    {
        try
        {
            return GetComProperty(target, propertyName);
        }
        catch
        {
            return null;
        }
    }

    private static int GetComIntProperty(object target, string propertyName)
    {
        return Convert.ToInt32(GetComProperty(target, propertyName));
    }

    private static long GetComLongProperty(object target, string propertyName)
    {
        return Convert.ToInt64(GetComProperty(target, propertyName));
    }

    private static object InvokeComMethod(object target, string methodName, params object[] arguments)
    {
        if (target == null) return null;
        return target.GetType().InvokeMember(methodName, BindingFlags.InvokeMethod, null, target, arguments);
    }

    private static void ReleaseComObject(object value)
    {
        if (value == null || !Marshal.IsComObject(value)) return;
        try
        {
            Marshal.FinalReleaseComObject(value);
        }
        catch (InvalidComObjectException)
        {
        }
    }

    private static string GetClassName(IntPtr window)
    {
        StringBuilder name = new StringBuilder(128);
        return NativeMethods.GetClassName(window, name, name.Capacity) > 0 ? name.ToString() : string.Empty;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int x;
        public int y;
    }

    private static class NativeMethods
    {
        [DllImport("user32.dll")]
        internal static extern short GetAsyncKeyState(int virtualKey);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetCursorPos(out Point point);

        [DllImport("user32.dll")]
        internal static extern int GetSystemMetrics(int index);

        [DllImport("user32.dll")]
        internal static extern IntPtr WindowFromPoint(Point point);

        [DllImport("user32.dll")]
        internal static extern IntPtr GetAncestor(IntPtr window, uint flags);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        internal static extern IntPtr SendMessageTimeout(IntPtr window, int message, IntPtr wParam, IntPtr lParam,
            uint flags, uint timeout, out IntPtr result);

        [DllImport("user32.dll")]
        internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        internal static extern int GetClassName(IntPtr window, StringBuilder className, int maxCount);

        [DllImport("oleacc.dll")]
        internal static extern int AccessibleObjectFromWindow(IntPtr window, uint objectId, ref Guid interfaceId,
            [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetProcessDPIAware();
    }
}
