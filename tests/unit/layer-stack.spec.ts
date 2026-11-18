import { describe, expect, it } from 'vitest'
import { isTopLayer, layerDepth, popLayer, pushLayer } from '../../src/client/layer-stack.ts'

describe('layer stack', () => {
  it('hands the keyboard to the layer pushed last', () => {
    const outer = {}
    const inner = {}
    pushLayer(outer)
    expect(isTopLayer(outer)).toBe(true)
    pushLayer(inner)
    expect(isTopLayer(inner)).toBe(true)
    expect(isTopLayer(outer)).toBe(false)
    popLayer(inner)
    expect(isTopLayer(outer)).toBe(true)
    popLayer(outer)
    expect(layerDepth()).toBe(0)
  })

  it('ignores a second push of the same layer', () => {
    const layer = {}
    pushLayer(layer)
    pushLayer(layer)
    expect(layerDepth()).toBe(1)
    popLayer(layer)
    expect(layerDepth()).toBe(0)
  })

  it('survives a middle layer leaving first', () => {
    const outer = {}
    const middle = {}
    const inner = {}
    pushLayer(outer)
    pushLayer(middle)
    pushLayer(inner)
    popLayer(middle)
    expect(isTopLayer(inner)).toBe(true)
    popLayer(inner)
    expect(isTopLayer(outer)).toBe(true)
    popLayer(outer)
    expect(layerDepth()).toBe(0)
  })

  it('has no top layer when empty', () => {
    expect(isTopLayer({})).toBe(false)
  })
})
