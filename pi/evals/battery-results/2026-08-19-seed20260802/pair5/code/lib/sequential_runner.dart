/// Runs a list of async tasks and collects their results.
class SequentialRunner {
  /// Runs each task in [tasks] and returns their results in order.
  ///
  /// Each task is awaited to completion before the next one starts.
  static Future<List<T>> runAll<T>(List<Future<T> Function()> tasks) async {
    final results = <T>[];
    for (final task in tasks) {
      results.add(await task());
    }
    return results;
  }
}
