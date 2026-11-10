namespace Transversals.GuestAgent.Tests;

/// <summary>
/// Scripted stdin for the NDJSON session runner. Each step waits a real delay and then yields a line.
/// After the script: EOF (null) or silence (a read that never completes unless cancelled).
/// </summary>
internal sealed class ScriptedLineReader : TextReader
{
    private readonly List<(TimeSpan Delay, string Line)> steps = [];
    private readonly bool eofAfterScript;
    private int next;
    private int reads;

    public ScriptedLineReader(bool eofAfterScript) => this.eofAfterScript = eofAfterScript;

    /// <summary>Number of read calls the runner started (including an abandoned one).</summary>
    public int Reads => Volatile.Read(ref reads);

    public ScriptedLineReader Line(string line, int afterMs = 0)
    {
        steps.Add((TimeSpan.FromMilliseconds(afterMs), line));
        return this;
    }

    public ScriptedLineReader Repeat(string line, int count, int everyMs)
    {
        for (int i = 0; i < count; i++) Line(line, everyMs);
        return this;
    }

    public override ValueTask<string?> ReadLineAsync(CancellationToken cancellationToken) =>
        new(ReadNextAsync(cancellationToken));

    public override Task<string?> ReadLineAsync() => ReadNextAsync(CancellationToken.None);

    public override string? ReadLine() => ReadNextAsync(CancellationToken.None).GetAwaiter().GetResult();

    private async Task<string?> ReadNextAsync(CancellationToken ct)
    {
        Interlocked.Increment(ref reads);
        int index = Interlocked.Increment(ref next) - 1;
        if (index < steps.Count)
        {
            (TimeSpan delay, string line) = steps[index];
            if (delay > TimeSpan.Zero) await Task.Delay(delay, ct);
            return line;
        }
        if (eofAfterScript) return null;
        await Task.Delay(Timeout.Infinite, ct);
        return null;
    }
}

/// <summary>Stand-in for NdjsonProtocolHandler.HandleLineAsync: echoes "resp:&lt;line&gt;", optionally slow or failing.</summary>
internal sealed class FakeLineHandler
{
    private readonly object gate = new();

    public List<string> Lines { get; } = [];

    /// <summary>Real time a given line takes to handle (default: immediate).</summary>
    public Func<string, TimeSpan> Cost { get; set; } = _ => TimeSpan.Zero;

    /// <summary>Exception to throw for a given line (default: none).</summary>
    public Func<string, Exception?> Failure { get; set; } = _ => null;

    public async Task<string> HandleAsync(string line, CancellationToken ct)
    {
        lock (gate) Lines.Add(line);
        TimeSpan cost = Cost(line);
        if (cost > TimeSpan.Zero) await Task.Delay(cost, CancellationToken.None);
        Exception? failure = Failure(line);
        if (failure is not null) throw failure;
        return $"resp:{line}";
    }

    public string[] Snapshot()
    {
        lock (gate) return [.. Lines];
    }
}

/// <summary>Captures stdout and counts flushes.</summary>
internal sealed class RecordingWriter : StringWriter
{
    public int Flushes { get; private set; }

    public override void Flush()
    {
        Flushes++;
        base.Flush();
    }

    public override Task FlushAsync()
    {
        Flushes++;
        return Task.CompletedTask;
    }

    public override Task FlushAsync(CancellationToken cancellationToken)
    {
        Flushes++;
        return Task.CompletedTask;
    }

    /// <summary>Non-empty output lines with any trailing CR removed.</summary>
    public string[] OutputLines() =>
        ToString().Split('\n').Select(line => line.TrimEnd('\r')).Where(line => line.Length > 0).ToArray();
}

/// <summary>
/// Mimics Console.In (a SyncTextReader over a pipe): every read overload blocks the CALLING thread until a
/// line is fed or input completes, then returns an already-completed task. Cancellation is ignored, like the
/// console. A safety cap ends a blocked read with null (EOF) so a failing test cannot hang the suite.
/// </summary>
internal sealed class SyncBlockingLineReader : TextReader
{
    private readonly System.Collections.Concurrent.BlockingCollection<string> lines = new();
    private readonly TimeSpan cap;

    public SyncBlockingLineReader(TimeSpan? cap = null) => this.cap = cap ?? TimeSpan.FromSeconds(5);

    public void Feed(string line) => lines.Add(line);

    public void Complete() => lines.CompleteAdding();

    public override string? ReadLine()
    {
        try
        {
            return lines.TryTake(out string? line, cap) ? line : null;
        }
        catch (InvalidOperationException)
        {
            return null; // completed and drained
        }
    }

    public override Task<string?> ReadLineAsync() => Task.FromResult(ReadLine());

    public override ValueTask<string?> ReadLineAsync(CancellationToken cancellationToken) =>
        ValueTask.FromResult(ReadLine());

    protected override void Dispose(bool disposing)
    {
        if (disposing && !lines.IsAddingCompleted) lines.CompleteAdding(); // release any abandoned read
        base.Dispose(disposing);
    }
}
