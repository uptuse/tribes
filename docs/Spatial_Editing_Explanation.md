# Tuning vs. Spatial Editing in Firewolf

**Author:** Manus AI

When you ask if you can "move the jet thrust location" or "move an asset," you are asking about the difference between **tuning** and **spatial editing**. 

The short answer is: **Yes, you can do both, but they require two different types of tools working together.**

Let's break down exactly how this works in the Firewolf architecture.

## 1. Tuning (The PCUI Panel)
Tuning is changing **numbers**. 
- How fast does the player run? (Speed: 15.0)
- How much damage does the Spinfusor do? (Damage: 50)
- What color is the jet exhaust? (Color: #00FFFF)

PCUI is perfect for this. You drag a slider, the number changes, and the game updates instantly.

## 2. Spatial Editing (Moving Things in 3D Space)
Moving an asset (like a tree, a building, or the exact spot where the jet exhaust comes out of the backpack) means changing **3D coordinates** (X, Y, Z).

If you want to move the jet thrust location, you are changing the `offset` vector where the particle emitter attaches to the player model.

### How you do this with PCUI (The Hard Way)
Technically, PCUI has a "Vector Input" Lego brick. It looks like three little number boxes: `[X: 0.0] [Y: 1.5] [Z: -0.5]`. 

You *could* type numbers into those boxes to move the jet exhaust. But guessing 3D coordinates by typing numbers is miserable. You want to grab the exhaust with your mouse and drag it to the right spot on the backpack.

### How you do this visually (The Right Way)
To grab and move an asset with your mouse, you need a **Transform Control**. This is the classic 3D widget with red, green, and blue arrows that you drag to move, rotate, or scale an object.

Because Firewolf uses Three.js for rendering, we have a massive advantage: **Three.js has a built-in `TransformControls` module.**

## The Vibe-Coding Workflow for Moving Assets

If you want to move the jet thrust location or rearrange buildings on the map, here is how we prompt the AI to build that capability into your editor:

### Step 1: The AI Adds the 3D Gizmo
You tell the AI: 
> "I want to be able to click on objects in the game world and move them around. Add the Three.js `TransformControls` to the editor."

The AI writes the code to add the red/green/blue arrows to the screen.

### Step 2: The AI Connects the Gizmo to the PCUI Panel
You tell the AI:
> "When I drag an object with the 3D arrows, update its X/Y/Z numbers in the PCUI inspector panel live. And if I type a number in the panel, move the object in the 3D world."

The AI wires the two tools together. Now they are synced.

### Step 3: You Vibe-Code the Jetpack
You open the game. You pause the action. You click on the jetpack exhaust emitter. The red/green/blue arrows appear. You drag the blue arrow backward until the exhaust lines up perfectly with the thruster nozzles on the 3D model. 

As you drag it, you see the numbers in the PCUI panel updating automatically (e.g., `Z: -0.85`). 

### Step 4: You Save the Result
Once it looks perfect, you tell the AI:
> "The jet exhaust offset is perfect now. Hardcode the new offset into the player setup code."

## Summary

- **PCUI** handles the UI panels, the sliders, and the exact numbers.
- **Three.js TransformControls** handles the visual grabbing and dragging in 3D space.

Because Firewolf is built on Three.js, bolting the visual dragging arrows onto the game is actually very easy. The AI just has to wire the Three.js arrows to the PCUI numbers so they talk to each other. 

So yes, you absolutely can move assets and adjust thrust locations visually. You just need the AI to add the 3D dragging arrows alongside the PCUI panels.
