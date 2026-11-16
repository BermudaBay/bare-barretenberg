package xyz.bermudabay.barretenberg.example

import android.app.Activity
import android.graphics.Typeface
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import to.holepunch.bare.kit.Ipc
import to.holepunch.bare.kit.Worklet

// Runs the example worklet (examples/app.js), in which the Bermuda SDK proves through
// @bermuda/bare-barretenberg, and shows what it reports.
class MainActivity : Activity() {
  private val scope = MainScope()

  // Closing a worklet terminates it, so it is kept for as long as the activity lives.
  private lateinit var worklet: Worklet

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val log = TextView(this).apply {
      typeface = Typeface.MONOSPACE
      setPadding(32, 32, 32, 32)
    }
    setContentView(ScrollView(this).apply { addView(log) })

    worklet = Worklet(this)
    val ipc = Ipc(worklet)
    worklet.start("app.bundle")

    scope.launch {
      // The worklet's first message is where it keeps the CRS: the app's private storage.
      ipc.write(filesDir.path.encodeToByteArray())
      ipc.data.collect { data -> log.append(data.decodeToString()) }
    }
  }

  override fun onDestroy() {
    scope.cancel()
    worklet.close()
    super.onDestroy()
  }
}
