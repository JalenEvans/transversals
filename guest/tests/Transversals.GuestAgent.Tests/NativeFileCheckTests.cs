using Transversals.GuestAgent.Host;

namespace Transversals.GuestAgent.Tests;

// The WPF native DLLs ship beside the exe; hello reports which are missing so doctor can flag a partial install.
public sealed class NativeFileCheckTests : IDisposable
{
    private static readonly string[] Expected =
        ["wpfgfx_cor3.dll", "PresentationNative_cor3.dll", "vcruntime140_cor3.dll", "PenImc_cor3.dll"];

    private readonly DirectoryInfo directory = Directory.CreateTempSubdirectory("transversals-native-");

    public void Dispose() => directory.Delete(recursive: true);

    private void Create(params string[] names)
    {
        foreach (string name in names) File.WriteAllBytes(Path.Combine(directory.FullName, name), [0]);
    }

    [Fact]
    public void Required_files_are_the_four_wpf_native_dlls_in_order() =>
        Assert.Equal(Expected, NativeFileCheck.RequiredFiles);

    [Fact]
    public void DLG1_all_present_reports_none_missing()
    {
        Create(Expected);
        Create("Transversals.GuestAgent.exe", "unrelated.dll");

        Assert.Empty(NativeFileCheck.FindMissing(directory.FullName));
    }

    [Fact]
    public void DLG2_reports_exactly_the_missing_files_in_required_order()
    {
        Create("PresentationNative_cor3.dll", "vcruntime140_cor3.dll", "Transversals.GuestAgent.exe");

        Assert.Equal(["wpfgfx_cor3.dll", "PenImc_cor3.dll"], NativeFileCheck.FindMissing(directory.FullName));
    }

    [Fact]
    public void DLG2_an_empty_directory_is_missing_all_four()
    {
        Assert.Equal(Expected, NativeFileCheck.FindMissing(directory.FullName));
    }

    [Fact]
    public void DLG2_a_same_named_directory_does_not_count_as_the_file()
    {
        Create("wpfgfx_cor3.dll", "PresentationNative_cor3.dll", "vcruntime140_cor3.dll");
        Directory.CreateDirectory(Path.Combine(directory.FullName, "PenImc_cor3.dll"));

        Assert.Equal(["PenImc_cor3.dll"], NativeFileCheck.FindMissing(directory.FullName));
    }
}
