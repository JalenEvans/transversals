using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Xunit.Sdk;

namespace Transversals.GuestAgent.Tests;

internal static class SemanticContract
{
    private const string Namespace = "Transversals.GuestAgent.Semantics";
    private static readonly Assembly Production = Assembly.Load("Transversals.GuestAgent");
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter() },
    };

    internal static Type RequireType(string name)
    {
        Type? type = Production.GetType($"{Namespace}.{name}");
        return type is { IsPublic: true }
            ? type
            : throw new XunitException($"Missing public semantic contract: {Namespace}.{name}");
    }

    internal static object FromJson(string typeName, string json) =>
        JsonSerializer.Deserialize(json, RequireType(typeName), JsonOptions)
        ?? throw new XunitException($"Could not create {typeName} from its public JSON shape");

    internal static object Create(string typeName, params object[] arguments) =>
        Activator.CreateInstance(RequireType(typeName), arguments)
        ?? throw new XunitException($"Could not construct {typeName}");

    internal static object Call(object target, string method, params object?[] arguments)
    {
        MethodInfo candidate = target.GetType().GetMethods()
            .SingleOrDefault(item => item.Name == method && item.GetParameters().Length == arguments.Length)
            ?? throw new XunitException($"Missing public semantic member: {target.GetType().Name}.{method}");

        try
        {
            return candidate.Invoke(target, arguments)
                ?? throw new XunitException($"{target.GetType().Name}.{method} returned null");
        }
        catch (TargetInvocationException error) when (error.InnerException is not null)
        {
            throw error.InnerException;
        }
    }

    internal static async Task<object?> CallAsync(object target, string method, params object?[] arguments)
    {
        object invocation = Call(target, method, arguments);
        if (invocation is not Task task)
        {
            throw new XunitException($"{target.GetType().Name}.{method} must return Task or Task<T>");
        }

        await task;
        return task.GetType().GetProperty("Result")?.GetValue(task);
    }

    internal static string StringProperty(object target, string property) =>
        target.GetType().GetProperty(property)?.GetValue(target)?.ToString()
        ?? throw new XunitException($"Missing public semantic property: {target.GetType().Name}.{property}");

    internal static TProxy CreateProxy<TProxy>(string interfaceName) where TProxy : DispatchProxy
    {
        object proxy = DispatchProxy.Create(RequireType(interfaceName), typeof(TProxy));
        return (TProxy)proxy;
    }

    internal static async Task<Exception> CaptureAsync(Func<Task> action)
    {
        try
        {
            await action();
        }
        catch (Exception error)
        {
            return error;
        }

        throw new XunitException("Expected the semantic operation to fail");
    }

    internal static void AssertTyped(Exception error, string typeName, string code)
    {
        Assert.Equal($"{Namespace}.{typeName}", error.GetType().FullName);
        Assert.Equal(code, StringProperty(error, "Code"));
    }
}

public class BackendProxy : DispatchProxy
{
    public object? Root { get; set; }
    public Exception? NextActionError { get; set; }
    public List<(string Id, string Kind, string? Value)> Actions { get; } = [];

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        Assert.NotNull(targetMethod);
        args ??= [];

        if (targetMethod.Name == "SnapshotAsync")
        {
            Assert.NotNull(Root);
            return CompletedGenericTask(targetMethod.ReturnType, Root);
        }

        if (targetMethod.Name == "InteractAsync")
        {
            if (NextActionError is Exception error)
            {
                NextActionError = null;
                return Task.FromException(error);
            }

            object action = args[1]!;
            Actions.Add((
                args[0]!.ToString()!,
                SemanticContract.StringProperty(action, "Kind"),
                action.GetType().GetProperty("Value")?.GetValue(action)?.ToString()));
            return Task.CompletedTask;
        }

        throw new XunitException($"Unexpected backend call: {targetMethod.Name}");
    }

    private static object CompletedGenericTask(Type taskType, object value)
    {
        Type resultType = taskType.GetGenericArguments().Single();
        return typeof(Task).GetMethod(nameof(Task.FromResult))!
            .MakeGenericMethod(resultType)
            .Invoke(null, [value])!;
    }
}

public class ClockProxy : DispatchProxy
{
    public DateTimeOffset Now { get; private set; } = DateTimeOffset.UnixEpoch;
    public int DelayCount { get; private set; }
    public Action<int>? AfterDelay { get; set; }

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        Assert.NotNull(targetMethod);
        args ??= [];

        return targetMethod.Name switch
        {
            "get_UtcNow" => Now,
            "DelayAsync" => Delay((TimeSpan)args[0]!),
            _ => throw new XunitException($"Unexpected clock call: {targetMethod.Name}"),
        };
    }

    private Task Delay(TimeSpan duration)
    {
        Now += duration;
        DelayCount += 1;
        AfterDelay?.Invoke(DelayCount);
        return Task.CompletedTask;
    }
}
