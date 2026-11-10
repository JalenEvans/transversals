using System.Buffers;
using System.Buffers.Binary;

namespace Transversals.GuestAgent.Host.Streaming;

/// <summary>Writes frames as a 4-byte big-endian length followed by the JPEG bytes, flushing after each frame.</summary>
internal sealed class FrameWriter(Stream output)
{
    private const int PrefixBytes = 4;

    public async Task WriteFrameAsync(ReadOnlyMemory<byte> jpeg, CancellationToken ct)
    {
        // One write per frame, so a reader never sees a prefix without (the start of) its body.
        int total = PrefixBytes + jpeg.Length;
        byte[] buffer = ArrayPool<byte>.Shared.Rent(total);
        try
        {
            BinaryPrimitives.WriteInt32BigEndian(buffer, jpeg.Length);
            jpeg.Span.CopyTo(buffer.AsSpan(PrefixBytes));
            await output.WriteAsync(buffer.AsMemory(0, total), ct).ConfigureAwait(false);
            await output.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }
}
