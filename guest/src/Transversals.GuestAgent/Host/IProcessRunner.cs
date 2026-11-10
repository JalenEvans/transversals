namespace Transversals.GuestAgent.Host;

public sealed record ProcessRunRequest(string Script, TimeSpan Timeout, int MaxOutputBytes);

public sealed record ProcessRunResult(
    int? ExitCode,
    string Stdout,
    string Stderr,
    bool StdoutTruncated,
    bool StderrTruncated,
    bool TimedOut);

public interface IProcessRunner
{
    Task<ProcessRunResult> RunPowerShellAsync(ProcessRunRequest request, CancellationToken ct);
}
