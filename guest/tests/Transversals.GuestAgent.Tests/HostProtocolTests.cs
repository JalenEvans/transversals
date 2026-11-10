using System.Text;
using System.Text.Json;
using Transversals.GuestAgent.Host;

namespace Transversals.GuestAgent.Tests;

public sealed class HostProtocolTests
{
    // ---------- G-1 hello ----------

    [Fact]
    public async Task Hello_returns_agent_identity_from_info_port()
    {
        HostHarness harness = new();
        harness.Info.AgentVersion = "9.8.7";
        harness.Info.ProtocolVersion = 3;
        harness.Info.SessionId = 42;
        harness.Info.IsInteractiveSession = false;

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "hello" });

        JsonElement result = HostResponse.SingleOkResult(response);
        Assert.Equal("9.8.7", result.GetProperty("agentVersion").GetString());
        Assert.Equal(3, result.GetProperty("protocolVersion").GetInt32());
        Assert.Equal(42, result.GetProperty("sessionId").GetInt32());
        Assert.False(result.GetProperty("interactiveSession").GetBoolean());
    }

    [Fact]
    public async Task DLG3_hello_reports_missing_native_files_from_info_port()
    {
        HostHarness harness = new();
        harness.Info.MissingNativeFiles = ["wpfgfx_cor3.dll", "PenImc_cor3.dll"];

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "hello" });

        JsonElement field = HostResponse.SingleOkResult(response).GetProperty("missingNativeFiles");
        Assert.Equal(JsonValueKind.Array, field.ValueKind);
        Assert.Equal(["wpfgfx_cor3.dll", "PenImc_cor3.dll"], field.EnumerateArray().Select(item => item.GetString()));
    }

    [Fact]
    public async Task DLG3_hello_reports_an_empty_missing_native_files_array_when_none_are_missing()
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "hello" });

        JsonElement result = HostResponse.SingleOkResult(response);
        Assert.True(result.TryGetProperty("missingNativeFiles", out JsonElement field), "hello has no missingNativeFiles");
        Assert.Equal(JsonValueKind.Array, field.ValueKind);
        Assert.Equal(0, field.GetArrayLength());
    }

    // ---------- G-2 / G-3 exec ----------

    [Fact]
    public async Task Exec_passes_exact_script_default_timeout_and_output_cap_to_runner()
    {
        HostHarness harness = new();
        const string script = "  Get-Process | Select-Object -First 1\n";

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "exec", script });

        HostResponse.SingleOkResult(response);
        ProcessRunRequest request = Assert.Single(harness.Process.Requests);
        Assert.Equal(script, request.Script);
        Assert.Equal(TimeSpan.FromMilliseconds(30_000), request.Timeout);
        Assert.Equal(65_536, request.MaxOutputBytes);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(5_000)]
    [InlineData(120_000)]
    public async Task Exec_passes_explicit_timeout_to_runner(int timeoutMs)
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "exec", script = "hostname", timeoutMs });

        HostResponse.SingleOkResult(response);
        ProcessRunRequest request = Assert.Single(harness.Process.Requests);
        Assert.Equal(TimeSpan.FromMilliseconds(timeoutMs), request.Timeout);
        Assert.Equal(65_536, request.MaxOutputBytes);
    }

    [Fact]
    public async Task Exec_accepts_script_at_the_8192_character_limit()
    {
        HostHarness harness = new();
        string script = new('x', 8_192);

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "exec", script });

        HostResponse.SingleOkResult(response);
        Assert.Equal(script, Assert.Single(harness.Process.Requests).Script);
    }

    [Fact]
    public async Task Exec_copies_runner_result_into_response()
    {
        HostHarness harness = new();
        harness.Process.NextResult = new ProcessRunResult(3, "hello stdout", "warn stderr", false, false, false);

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "exec", script = "exit 3" });

        JsonElement result = HostResponse.SingleOkResult(response);
        Assert.Equal(3, result.GetProperty("exitCode").GetInt32());
        Assert.Equal("hello stdout", result.GetProperty("stdout").GetString());
        Assert.Equal("warn stderr", result.GetProperty("stderr").GetString());
        Assert.False(result.GetProperty("stdoutTruncated").GetBoolean());
        Assert.False(result.GetProperty("stderrTruncated").GetBoolean());
        Assert.False(result.GetProperty("timedOut").GetBoolean());
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task Exec_surfaces_runner_truncation_flags_unchanged(bool stdoutTruncated, bool stderrTruncated)
    {
        HostHarness harness = new();
        harness.Process.NextResult = new ProcessRunResult(0, "partial", "partial-err", stdoutTruncated, stderrTruncated, false);

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "exec", script = "big-output" });

        JsonElement result = HostResponse.SingleOkResult(response);
        Assert.Equal(stdoutTruncated, result.GetProperty("stdoutTruncated").GetBoolean());
        Assert.Equal(stderrTruncated, result.GetProperty("stderrTruncated").GetBoolean());
        Assert.Equal(65_536, Assert.Single(harness.Process.Requests).MaxOutputBytes);
    }

    [Fact]
    public async Task Exec_timed_out_reports_null_exit_code_and_timed_out_flag()
    {
        HostHarness harness = new();
        harness.Process.NextResult = new ProcessRunResult(null, "", "", false, false, true);

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "exec", script = "Start-Sleep 999", timeoutMs = 10 });

        JsonElement result = HostResponse.SingleOkResult(response);
        Assert.True(result.GetProperty("timedOut").GetBoolean());
        Assert.True(
            result.TryGetProperty("exitCode", out JsonElement exitCode),
            $"exitCode must be present (as null) when timed out: {result.GetRawText()}");
        Assert.Equal(JsonValueKind.Null, exitCode.ValueKind);
    }

    public static TheoryData<string> InvalidExecCommands => new()
    {
        """{"type":"exec"}""",
        """{"type":"exec","script":""}""",
        JsonSerializer.Serialize(new { type = "exec", script = new string('x', 8_193) }),
        """{"type":"exec","script":"hostname","timeoutMs":0}""",
        """{"type":"exec","script":"hostname","timeoutMs":120001}""",
    };

    [Theory]
    [MemberData(nameof(InvalidExecCommands))]
    public async Task Exec_rejects_invalid_requests_without_running(string command)
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendAsync($$"""{"id":"bad-exec","commands":[{{command}}]}""");

        HostResponse.AssertValidationRejection(response);
        Assert.Empty(harness.Process.Requests);
    }

    // ---------- G-4 screenshot ----------

    [Fact]
    public async Task Screenshot_defaults_to_1568_and_returns_base64_png()
    {
        HostHarness harness = new();
        byte[] png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 9, 9];
        harness.Screen.Factory = _ => new CapturedImage(1568, 441, png);

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "screenshot" });

        JsonElement result = HostResponse.SingleOkResult(response);
        Assert.Equal([1568], harness.Screen.Requests);
        Assert.Equal("image/png", result.GetProperty("mimeType").GetString());
        Assert.Equal(1568, result.GetProperty("width").GetInt32());
        Assert.Equal(441, result.GetProperty("height").GetInt32());
        Assert.Equal(png, Convert.FromBase64String(result.GetProperty("data").GetString()!));
    }

    [Theory]
    [InlineData(320)]
    [InlineData(1280)]
    [InlineData(3840)]
    public async Task Screenshot_passes_valid_max_long_edge_to_capture(int maxLongEdge)
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "screenshot", maxLongEdge });

        JsonElement result = HostResponse.SingleOkResult(response);
        Assert.Equal([maxLongEdge], harness.Screen.Requests);
        Assert.Equal(maxLongEdge, result.GetProperty("width").GetInt32());
    }

    [Theory]
    [InlineData(319)]
    [InlineData(3841)]
    [InlineData(0)]
    public async Task Screenshot_rejects_out_of_range_max_long_edge_without_capturing(int maxLongEdge)
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "screenshot", maxLongEdge });

        HostResponse.AssertValidationRejection(response);
        Assert.Empty(harness.Screen.Requests);
    }

    [Fact]
    public async Task Screenshot_halves_max_long_edge_until_result_fits_the_byte_budget()
    {
        const int budget = 64 * 1024;
        HostHarness harness = new(responseByteBudget: budget);
        // 40 raw bytes per pixel of long edge: 1568 (default) -> 62,720 bytes (~84 KiB base64, too big);
        // 784 -> 31,360 bytes (~42 KiB base64, fits a 64 KiB budget).
        harness.Screen.Factory = edge => new CapturedImage(edge, edge / 2, Enumerable.Repeat((byte)7, edge * 40).ToArray());

        string raw = await harness.SendRawAsync("""{"id":"shot","commands":[{"type":"screenshot"}]}""");

        using JsonDocument response = JsonDocument.Parse(raw);
        JsonElement result = HostResponse.SingleOkResult(response);
        Assert.Equal([1568, 784], harness.Screen.Requests);
        Assert.Equal(784, result.GetProperty("width").GetInt32());
        Assert.Equal(784 * 40, Convert.FromBase64String(result.GetProperty("data").GetString()!).Length);
        Assert.True(Encoding.UTF8.GetByteCount(raw) <= budget);
    }

    [Fact]
    public async Task Screenshot_fails_with_backend_failure_when_even_the_320_floor_exceeds_the_budget()
    {
        HostHarness harness = new(responseByteBudget: 64 * 1024);
        harness.Screen.Factory = edge => new CapturedImage(edge, edge / 2, new byte[100_000]);

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "screenshot" });

        HostResponse.AssertError(response, 0, "BACKEND_FAILURE");
        List<int> requests = harness.Screen.Requests;
        Assert.True(requests.Count >= 2, $"Expected downscale retries, got [{string.Join(", ", requests)}]");
        Assert.Equal(1568, requests[0]);
        Assert.Equal(320, requests[^1]);
        Assert.All(requests, edge => Assert.InRange(edge, 320, 1568));
        Assert.True(requests.Zip(requests.Skip(1)).All(pair => pair.Second < pair.First), "Retries must strictly decrease.");
    }

    // ---------- R-1 screenshot reports virtual-screen bounds ----------
    // Seam: the source rect comes from IScreenCapture.VirtualScreen (FakeScreenCapture.VirtualScreen).
    // WindowsScreenCapture.FitLongEdge is private Win32-side code and is not tested directly.

    private static void AssertScreen(JsonElement result, ScreenBounds expected)
    {
        JsonElement screen = result.GetProperty("screen");
        Assert.Equal(expected.Left, screen.GetProperty("left").GetInt32());
        Assert.Equal(expected.Top, screen.GetProperty("top").GetInt32());
        Assert.Equal(expected.Width, screen.GetProperty("width").GetInt32());
        Assert.Equal(expected.Height, screen.GetProperty("height").GetInt32());
    }

    [Fact]
    public async Task Screenshot_reports_the_source_virtual_screen_alongside_a_downscaled_image()
    {
        HostHarness harness = new();
        ScreenBounds source = new(-1920, 0, 3840, 1080);
        harness.Screen.VirtualScreen = source;
        harness.Screen.Factory = _ => new CapturedImage(1568, 441, [1, 2, 3]);

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "screenshot" });

        JsonElement result = HostResponse.SingleOkResult(response);
        AssertScreen(result, source);
        int width = result.GetProperty("width").GetInt32();
        int height = result.GetProperty("height").GetInt32();
        Assert.True(width < source.Width && height < source.Height, "Downscaled image must be smaller than the screen.");
        Assert.Equal((long)width * source.Height, (long)height * source.Width);
    }

    [Fact]
    public async Task Screenshot_reports_equal_screen_and_image_size_when_not_downscaled()
    {
        HostHarness harness = new();
        ScreenBounds source = new(0, 0, 1280, 800);
        harness.Screen.VirtualScreen = source;
        harness.Screen.Factory = _ => new CapturedImage(1280, 800, [1, 2, 3]);

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "screenshot" });

        JsonElement result = HostResponse.SingleOkResult(response);
        AssertScreen(result, source);
        Assert.Equal(1280, result.GetProperty("width").GetInt32());
        Assert.Equal(800, result.GetProperty("height").GetInt32());
    }

    [Fact]
    public async Task Screenshot_still_reports_the_source_screen_after_budget_halving()
    {
        const int budget = 64 * 1024;
        HostHarness harness = new(responseByteBudget: budget);
        ScreenBounds source = new(-1920, 0, 3840, 1080);
        harness.Screen.VirtualScreen = source;
        harness.Screen.Factory = edge => new CapturedImage(edge, edge * 1080 / 3840, Enumerable.Repeat((byte)7, edge * 40).ToArray());

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "screenshot" });

        JsonElement result = HostResponse.SingleOkResult(response);
        Assert.Equal([1568, 784], harness.Screen.Requests);
        Assert.Equal(784, result.GetProperty("width").GetInt32());
        AssertScreen(result, source);
    }

    // ---------- NN3 default max long edge is 1568 ----------
    // FitLongEdge is private in the Win32 capture, so the fake mirrors its floor-scaling; the host-side
    // contract under test is the default edge requested and the source/image sizes reported.

    [Fact]
    public async Task Screenshot_without_max_long_edge_fits_a_2560x1402_source_to_1568()
    {
        HostHarness harness = new();
        ScreenBounds source = new(0, 0, 2560, 1402);
        harness.Screen.VirtualScreen = source;
        harness.Screen.Factory = edge =>
        {
            double scale = Math.Min(1.0, (double)edge / Math.Max(source.Width, source.Height));
            return new CapturedImage((int)Math.Floor(source.Width * scale), (int)Math.Floor(source.Height * scale), [1, 2, 3]);
        };

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "screenshot" });

        JsonElement result = HostResponse.SingleOkResult(response);
        Assert.Equal([1568], harness.Screen.Requests);
        int width = result.GetProperty("width").GetInt32();
        int height = result.GetProperty("height").GetInt32();
        Assert.Equal(1568, Math.Max(width, height));
        Assert.Equal(858, height); // floor(1402 * 1568 / 2560)
        Assert.Equal(source.Width / (double)source.Height, width / (double)height, 2);
        AssertScreen(result, source);
    }

    // ---------- G-5 input ----------

    [Fact]
    public async Task Input_type_sends_exact_text()
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "input", action = "type", text = "Hello, Wörld!\n" });

        HostResponse.AssertCompleted(response);
        Assert.Equal(["Hello, Wörld!\n"], harness.Input.TypedTexts);
    }

    [Fact]
    public async Task Input_type_accepts_text_at_the_16384_character_limit()
    {
        HostHarness harness = new();
        string text = new('a', 16_384);

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "input", action = "type", text });

        HostResponse.AssertCompleted(response);
        Assert.Equal(text, Assert.Single(harness.Input.TypedTexts));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(16_385)]
    public async Task Input_type_rejects_text_outside_length_limits(int length)
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendCommandsAsync(
            new { type = "input", action = "type", text = new string('a', length) });

        HostResponse.AssertValidationRejection(response);
        Assert.Equal(0, harness.Input.CallCount);
    }

    [Fact]
    public async Task Input_keys_normalizes_chord_before_sending()
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "input", action = "keys", keys = "Ctrl + SHIFT+s" });

        HostResponse.AssertCompleted(response);
        IReadOnlyList<string> chord = Assert.Single(harness.Input.Chords);
        Assert.Equal(["ctrl", "shift", "s"], chord);
    }

    [Theory]
    [InlineData("ctrl+bogus")]
    [InlineData("")]
    [InlineData("ctrl++s")]
    [InlineData("ctrl+shift+alt+win+a+c+s")]
    public async Task Input_keys_rejects_invalid_chords_without_sending(string keys)
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "input", action = "keys", keys });

        HostResponse.AssertValidationRejection(response);
        Assert.Empty(harness.Input.Chords);
    }

    [Fact]
    public async Task Input_click_defaults_to_single_left_click()
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "input", action = "click", x = 100, y = 200 });

        HostResponse.AssertCompleted(response);
        Assert.Equal([(100, 200, MouseButton.Left, false)], harness.Input.Clicks);
    }

    [Fact]
    public async Task Input_click_honors_right_button_and_double()
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendCommandsAsync(
            new { type = "input", action = "click", x = -5, y = 10, button = "right", @double = true });

        HostResponse.AssertCompleted(response);
        Assert.Equal([(-5, 10, MouseButton.Right, true)], harness.Input.Clicks);
    }

    [Theory]
    [InlineData(-1920, 0)]
    [InlineData(1919, 1079)]
    public async Task Input_click_accepts_virtual_screen_edges(int x, int y)
    {
        HostHarness harness = new(); // VirtualScreen = (-1920, 0, 3840, 1080)

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "input", action = "click", x, y });

        HostResponse.AssertCompleted(response);
        Assert.Equal([(x, y, MouseButton.Left, false)], harness.Input.Clicks);
    }

    [Theory]
    [InlineData("""{"type":"input","action":"click","x":-1921,"y":0}""")]
    [InlineData("""{"type":"input","action":"click","x":1920,"y":0}""")]
    [InlineData("""{"type":"input","action":"click","x":0,"y":-1}""")]
    [InlineData("""{"type":"input","action":"click","x":0,"y":1080}""")]
    [InlineData("""{"type":"input","action":"click","x":1.5,"y":10}""")]
    [InlineData("""{"type":"input","action":"click","y":10}""")]
    [InlineData("""{"type":"input","action":"click","x":10,"y":10,"button":"middle"}""")]
    public async Task Input_click_rejects_invalid_coordinates_and_buttons_without_clicking(string command)
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendAsync($$"""{"id":"bad-click","commands":[{{command}}]}""");

        HostResponse.AssertValidationRejection(response);
        Assert.Empty(harness.Input.Clicks);
    }

    [Fact]
    public async Task Input_unknown_action_is_rejected()
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "input", action = "scroll" });

        HostResponse.AssertValidationRejection(response);
        Assert.Equal(0, harness.Input.CallCount);
    }

    // ---------- G-6 windows ----------

    [Fact]
    public async Task Windows_list_returns_window_summaries()
    {
        HostHarness harness = new();
        harness.Windows.Windows.Add(new WindowInfo(4_294_967_297, "Untitled - Notepad", 1234, "notepad", true));
        harness.Windows.Windows.Add(new WindowInfo(66, "Calculator", 5678, "CalculatorApp", false));

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "windows", action = "list" });

        JsonElement[] windows = HostResponse.SingleOkResult(response).GetProperty("windows").EnumerateArray().ToArray();
        Assert.Equal(2, windows.Length);
        Assert.Equal(4_294_967_297, windows[0].GetProperty("handle").GetInt64());
        Assert.Equal("Untitled - Notepad", windows[0].GetProperty("title").GetString());
        Assert.Equal(1234, windows[0].GetProperty("processId").GetInt32());
        Assert.Equal("notepad", windows[0].GetProperty("processName").GetString());
        Assert.True(windows[0].GetProperty("isForeground").GetBoolean());
        Assert.Equal(66, windows[1].GetProperty("handle").GetInt64());
        Assert.False(windows[1].GetProperty("isForeground").GetBoolean());
    }

    [Fact]
    public async Task Windows_focus_known_handle_completes()
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "windows", action = "focus", handle = 4_294_967_297 });

        HostResponse.AssertCompleted(response);
        Assert.Equal([4_294_967_297L], harness.Windows.FocusRequests);
    }

    [Fact]
    public async Task Windows_focus_unknown_handle_returns_not_found()
    {
        HostHarness harness = new();
        harness.Windows.FocusResult = false;

        using JsonDocument response = await harness.SendCommandsAsync(new { type = "windows", action = "focus", handle = 99 });

        HostResponse.AssertError(response, 0, "NOT_FOUND");
        Assert.Equal([99L], harness.Windows.FocusRequests);
    }

    // ---------- G-7 capability gating and batching ----------

    [Theory]
    [InlineData("""{"type":"hello"}""")]
    [InlineData("""{"type":"exec","script":"hostname"}""")]
    [InlineData("""{"type":"screenshot"}""")]
    [InlineData("""{"type":"input","action":"type","text":"hi"}""")]
    [InlineData("""{"type":"windows","action":"list"}""")]
    public async Task Host_commands_without_ports_return_capability_unavailable(string command)
    {
        HostHarness harness = new(withPorts: false);

        using JsonDocument response = await harness.SendAsync($$"""{"id":"legacy","commands":[{{command}}]}""");

        HostResponse.AssertError(response, 0, "CAPABILITY_UNAVAILABLE");
    }

    [Fact]
    public async Task Legacy_handler_runs_semantic_commands_then_fails_at_the_host_command_index()
    {
        HostHarness harness = new(withPorts: false);

        using JsonDocument response = await harness.SendAsync(
            """
            {"id":"legacy-mixed","commands":[
              {"type":"find","locator":{"automationId":"stop"}},
              {"type":"screenshot"}
            ]}
            """);

        HostResponse.AssertError(response, 1, "CAPABILITY_UNAVAILABLE");
    }

    [Fact]
    public async Task Mixed_semantic_and_host_batch_returns_ordered_results()
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendAsync(
            """
            {"id":"mixed","commands":[
              {"type":"find","locator":{"automationId":"stop"}},
              {"type":"hello"},
              {"type":"interact","ref":"$last","action":{"kind":"Invoke"}},
              {"type":"windows","action":"list"}
            ]}
            """);

        JsonElement root = response.RootElement;
        Assert.True(root.GetProperty("status").GetString() == "ok", root.GetRawText());
        JsonElement results = root.GetProperty("results");
        Assert.Equal(4, results.GetArrayLength());
        Assert.Equal("1.2.3-test", results[1].GetProperty("agentVersion").GetString());
        Assert.True(results[3].TryGetProperty("windows", out _));
        // $last still refers to the semantic find result across an intervening host command.
        Assert.Equal([("stop", "Invoke")], harness.Backend.Actions);
    }

    [Fact]
    public async Task Mixed_batch_fails_fast_at_the_invalid_host_command_index()
    {
        HostHarness harness = new();

        using JsonDocument response = await harness.SendAsync(
            """
            {"id":"mixed-fail","commands":[
              {"type":"find","locator":{"automationId":"stop"}},
              {"type":"hello"},
              {"type":"exec","script":""},
              {"type":"input","action":"type","text":"never"}
            ]}
            """);

        HostResponse.AssertValidationRejection(response, commandIndex: 2);
        Assert.Empty(harness.Process.Requests);
        Assert.Empty(harness.Input.TypedTexts);
    }
}
