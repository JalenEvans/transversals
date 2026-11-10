namespace Transversals.GuestAgent.Host;

/// <summary>
/// The WPF native DLLs ship beside the exe (no self-extraction cache). A partial install that lacks one
/// only fails when WPF first loads, so hello reports what is missing and doctor can flag it up front.
/// </summary>
internal static class NativeFileCheck
{
    public static readonly IReadOnlyList<string> RequiredFiles =
        ["wpfgfx_cor3.dll", "PresentationNative_cor3.dll", "vcruntime140_cor3.dll", "PenImc_cor3.dll"];

    /// <summary>The required files not present as files in <paramref name="directory"/>, in required order.</summary>
    public static IReadOnlyList<string> FindMissing(string directory) =>
        RequiredFiles.Where(name => !File.Exists(Path.Combine(directory, name))).ToArray();
}
