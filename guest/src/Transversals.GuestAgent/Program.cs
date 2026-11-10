using Transversals.GuestAgent.Host;
using Transversals.GuestAgent.Host.Streaming;
using Transversals.GuestAgent.Host.Win32;
using Transversals.GuestAgent.Semantics;

namespace Transversals.GuestAgent;

internal static class Program
{
    private const int ExitUsage = 2;

    private const string StreamUsage =
        "Usage: Transversals.GuestAgent.exe [stream [--fps 1-30] [--max-long-edge 320-1920] [--quality 30-95]]";

    /// <summary>No arguments selects the NDJSON session, <c>stream</c> the frame stream; anything else is invalid.</summary>
    internal static AgentMode ResolveMode(string[] args) =>
        args.Length == 0 ? AgentMode.Ndjson
        : args[0] == "stream" ? AgentMode.Stream
        : AgentMode.Invalid;

    private static async Task<int> Main(string[] args)
    {
        // prlctl exec hands the agent real pipes for stdin/stdout/stderr, but as a console-subsystem
        // exe it still gets a visible console (Windows Terminal/OpenConsole) in the interactive session.
        // Detach before anything touches Console: FreeConsole leaves the inherited pipe std handles
        // intact, and Console.In/Out resolve them lazily via GetStdHandle on first use.
        if (OperatingSystem.IsWindows() && NativeMethods.GetConsoleWindow() != IntPtr.Zero)
        {
            NativeMethods.FreeConsole();
        }

        // Physical-pixel coordinates so screenshots, stream frames, virtual-screen bounds, and clicks agree
        // on scaled displays. Fails harmlessly if awareness was already set (e.g. by a manifest).
        NativeMethods.SetProcessDpiAwarenessContext(NativeMethods.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

        switch (ResolveMode(args))
        {
            case AgentMode.Stream:
                return await RunStreamAsync(args[1..]).ConfigureAwait(false);
            case AgentMode.Invalid:
                await Console.Error.WriteLineAsync($"Unknown command \"{args[0]}\".\n{StreamUsage}").ConfigureAwait(false);
                return ExitUsage;
            default:
                return await RunNdjsonAsync().ConfigureAwait(false);
        }
    }

    private static async Task<int> RunStreamAsync(string[] flags)
    {
        if (!StreamOptions.TryParse(flags, out StreamOptions? options, out string? error))
        {
            await Console.Error.WriteLineAsync($"{error}\n{StreamUsage}").ConfigureAwait(false);
            return ExitUsage;
        }

        // The session ends itself (stdin EOF, missed heartbeat, or a failed/stalled write); after FreeConsole
        // there are no console control events to cancel it, so no shutdown token is needed.
        // Not disposed: disposing could block on a write stalled against a full pipe and hang the exit.
        Stream stdout = Console.OpenStandardOutput();
        Stream stdin = Console.OpenStandardInput();
        return await StreamSession.RunAsync(
            options!,
            new WindowsScreenCapture(),
            stdout,
            stdin,
            new StopwatchStreamClock(),
            StreamLimits.Default,
            CancellationToken.None).ConfigureAwait(false);
    }

    private static async Task<int> RunNdjsonAsync()
    {
        GuestHostPorts ports = new(
            new WindowsAgentInfo(),
            new WindowsProcessRunner(),
            new WindowsScreenCapture(),
            new WindowsInputSender(),
            new WindowsWindowManager());
        NdjsonProtocolHandler protocol = new(
            new SemanticSession(new WindowsUiaBackend(), new SystemSemanticClock()),
            ports);

        // On an idle timeout the runner abandons a Console.In.ReadLine still blocked on the pipe. The runner
        // runs that read through Task.Run (Console.In's own ReadLineAsync would block this thread), so it sits
        // on a background thread-pool thread and returning from Main still ends the process.
        // The session ends itself (stdin EOF or the idle timeout); after FreeConsole there are no console
        // control events to cancel it, so no shutdown token is needed.
        return await NdjsonSessionRunner.RunAsync(
            protocol.HandleLineAsync,
            Console.In,
            Console.Out,
            NdjsonSessionRunner.DefaultIdleTimeout,
            CancellationToken.None,
            error => Console.Error.WriteLine(error is TimeoutException ? error.Message : error.ToString()))
            .ConfigureAwait(false);
    }
}
