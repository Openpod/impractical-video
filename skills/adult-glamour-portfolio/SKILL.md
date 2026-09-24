---
name: adult-glamour-portfolio
description: Use when creating or revising adult female characters meant to be attractive, beautiful, sensual, alluring, glamorous, model-like, busty, voluptuous, curvy, fashionable, or supermodel-coded. Applies to reference.md writing, character portfolio prompts, and keyframe instructions that must preserve the attractive adult glamour identity.
---

# Adult Glamour Portfolio

Use this skill to make adult female character portfolios look intentionally
attractive instead of generic. The portfolio is the identity anchor; if the
portfolio is bland, keyframes and clips will preserve blandness.

Hard boundary: only apply to clearly adult characters. If the character is a
minor, teen, school-age, childlike, or ambiguous-age, do not use glamour or
sensual body-language cues.

## Prompting Rules

- Write affirmative visual detail. Do not rely on `beautiful`, `attractive`, or
  `SFW` as the main instruction.
- Avoid broad safety hedges in model-facing prompts: omit `SFW`, `non-explicit`,
  `no nudity`, and similar wording unless the provider requires it.
- Do not add garment exclusions by default. If the user asks for pants, include
  pants. If they ask for a bodysuit, underwear, deep neckline, bare legs, or
  cleavage, describe that exact wardrobe affirmatively.
- Emphasize assets through body, pose, wardrobe, camera, and lighting:
  supermodel-level face, full bust, narrow/defined waist, shapely hips,
  long legs, confident posture, and editorial glamour styling.
- Use a PromptCat-style breakdown instead of one generic sentence: subject,
  hair, face, anatomy, wardrobe fit, pose, environment, camera, lighting,
  mood, realism, texture, and preservation negatives.
- For portfolio contact sheets, keep the attractive identity consistent across
  all nine cells: face, body proportions, posture, hair, makeup, and wardrobe.
- Do not copy single-image framing negatives blindly. If a source prompt says
  `no full body`, translate that into row-specific emphasis while still making
  the required 3x3 portfolio grid.

## Reference Pattern

Use this structure in `references/characters/<id>/reference.md`:

```text
Adult woman, late 20s to early 30s, supermodel-level facial beauty:
striking symmetrical features, sculpted cheekbones, expressive eyes, full lips,
luminous skin, polished hair, high-end editorial makeup. Voluptuous
fashion-model physique: full bust, defined waist, shapely hips, long legs,
confident sensual posture. Wardrobe: [specific user wardrobe]. Overall presence:
[domain role] with alluring, composed, high-status body language.
```

## Portfolio Prompt Pattern

Use this inside `generateReferencePortfolio.prompt` after the generic 3x3
contact-sheet instructions:

```text
Adult woman, late 20s to early 30s, [ethnicity/style/role], consistent identity
across all 9 cells. Supermodel-level facial beauty: striking symmetrical face,
sculpted cheekbones, expressive eyes, full lips, luminous skin, polished hair,
high-end editorial makeup.

Anatomy and silhouette: voluptuous fashion-model physique, full bust, defined
waist, shapely hips, long legs, confident sensual posture. Wardrobe:
[exact user wardrobe], fitted and styled to emphasize the intended silhouette
and neckline with high-fashion editorial glamour.

Portfolio requirements: Row 1 full-body silhouette and wardrobe; Row 2 medium
shots showing posture, waist/hip line, bust/neckline, and body language; Row 3
close-ups of face, hair, makeup, fabric texture, and distinctive styling.
Mood: alluring, confident, composed. Camera and lighting: luxury fashion
campaign, beauty lighting, crisp detail, cinematic editorial framing.

Preservation negatives: avoid anatomy normalization, body proportion averaging,
smaller bust than briefed, reduced chest volume, flattened/compressed curves,
slimmed torso, generic dataset-average female anatomy, beauty-filter smoothing,
plastic skin, airbrushed texture, and naturalization of prominent features.
```

## PromptCat-Derived Pattern

Observed common denominator from the provided PromptCat examples:

- They are structured like JSON fields, not loose prose.
- The body is specified materially: bust volume, waist ratio, hip/glute curve,
  torso shape, skin texture, fabric tension, and visible silhouette.
- Camera and pose are doing real work: rear/side/profile/low/high angle,
  direct eye contact, arched posture, forward lean, or upper-body framing.
- Lighting and capture style are concrete: flash shadows, smartphone realism,
  bathroom overhead light, mirror reflection, CCD grain, or social-photo rawness.
- Negative prompts protect the intended asset shape: no anatomy averaging,
  no reduced chest volume, no flattened depth, no smoothing/airbrushing, no
  generic editorial proportions, no naturalizing prominent features.
- For this app, convert them into a 3x3 identity portfolio: full-body identity
  row, medium glamour/pose row, close-up detail row.

Use this JSON-like shape when the agent needs stronger asset handling. Rewrite
the fields for the actual character; do not paste unrelated garments, props, or
poses from examples into a user's request.

```text
{
  "subject": {
    "adult_identity": "Adult woman in her 20s or 30s, role/style/ethnicity as requested.",
    "hair": "Precise color, cut, volume, styling, loose strands, and face framing.",
    "face": "Supermodel-level symmetry, sculpted cheekbones, expressive eyes, full lips, makeup style, gaze.",
    "anatomy": "Voluptuous hourglass physique, full bust, defined waist, shapely hips/glutes, long legs or upper-body silhouette as the shot requires.",
    "skin_and_texture": "Realistic pores, natural softness, sheen/wetness/tan lines/skin detail only when appropriate.",
    "wardrobe": "Exact user wardrobe; describe fabric tension, neckline, crop, stretch, fit, leg line, cleavage, waist, hip, and silhouette effects."
  },
  "pose": {
    "portfolio_row_1": "Full-body identity views: front, 3/4, side/profile; preserve body proportions and wardrobe.",
    "portfolio_row_2": "Medium glamour views: direct gaze, torso twist, back arch, hand placement, high/low/rear/side angle as appropriate.",
    "portfolio_row_3": "Close-up details: face, eyes, hair, makeup, neckline, fabric, hands, skin texture, accessories."
  },
  "camera": {
    "capture_style": "Luxury editorial, raw phone flash, mirror selfie, bathroom overhead, CCD snapshot, or other requested style.",
    "angle": "Use camera angle to emphasize intended silhouette without losing identity consistency.",
    "framing": "3x3 portfolio grid; do not obey single-image 'no full body' negatives for the whole portfolio."
  },
  "lighting_and_realism": {
    "lighting": "Hard flash, warm lamp, window daylight, harsh bathroom light, dim CCD flash, or requested scene light.",
    "realism": "Photorealistic detail, visible fabric/skin texture, no generic smoothing unless requested."
  },
  "preservation_negatives": [
    "no anatomy averaging",
    "no reduced bust/chest volume when briefed",
    "no flattened/compressed curves",
    "no slimmed torso unless requested",
    "no generic dataset-average body",
    "no beauty-filter smoothing",
    "no plastic or airbrushed skin",
    "no naturalizing prominent requested features"
  ]
}
```

## Example: Flash Room Glamour Grid

```text
Adult woman in her late 20s, glamorous social-photo identity, consistent across
all 9 cells. Long polished blonde hair, fair realistic skin, supermodel-level
facial symmetry, full lips, sculpted cheekbones, confident direct gaze.

Anatomy and silhouette: curvy fit hourglass figure, full bust, narrow defined
waist, prominent hip/glute curve, long legs, soft realistic skin texture.
Wardrobe: fluffy pink winter hat, cropped fuzzy pink top exposing the midriff,
high-cut lingerie-inspired bottoms, all fitted to emphasize the intended bust,
waist, hip, and leg silhouette.

Portfolio requirements: Row 1 full-body front, 3/4, and side views preserving
the wardrobe and hourglass silhouette. Row 2 medium rear/side/profile glamour
poses with direct eye contact, lower-back arch, confident hand placement, and
clear waist/hip/bust volume. Row 3 close-ups of face, hair, makeup, faux-fur
texture, fabric fit, skin texture, and distinctive styling. Camera and lighting:
raw smartphone flash, hard shadow, casual indoor room, crisp realism.

Preservation negatives: no anatomy normalization, no body proportion averaging,
no smaller bust than briefed, no reduced chest volume, no flattened curves,
no slimmed torso, no beauty-filter smoothing, no plastic skin, no generic
dataset-average female body.
```

## Example: Wet Candid Glamour Grid

```text
Adult woman in her 20s, platinum blonde hair with dark roots in a messy high
bun, glamorous candid bathroom/shower visual identity, consistent across all
9 cells. Striking face, hoop earrings, delicate necklace, focused upward gaze,
wet glistening skin with visible pores and water droplets.

Anatomy and silhouette: full heavy bust with natural volume, visible cleavage,
defined waist, curvy fit torso, shapely hips, strong sensual posture. Wardrobe:
black strapless bandeau top and matching dark fitted bottoms, wet fabric and
skin sheen emphasized.

Portfolio requirements: Row 1 full-body standing and crouched identity views
showing proportions and wardrobe. Row 2 medium high-angle/top-down glamour
studies with forward lean, direct lens gaze, and preserved chest/torso volume.
Row 3 close-ups of face, wet hair strands, skin droplets, jewelry, fabric edge,
and shower-tile environment. Camera and lighting: harsh bathroom overhead
light, phone-photo realism, wet reflections, sharp detail.

Preservation negatives: no anatomy averaging, no reduced chest volume, no
flattened depth, no dry-skin reinterpretation, no airbrushing, no stylized
beauty render, no standing-only pose if the brief calls for crouched variants.
```

## Example: Mirror Curve Portfolio

```text
Adult woman in her mid-to-late 20s, influencer-style mirror/glass selfie
identity, consistent across all 9 cells. Blonde bob, fair warm skin, soft
facial features, relaxed self-assured expression, polished but candid beauty.

Anatomy and silhouette: voluptuous hourglass physique, significant bust volume,
natural heaviness and projection, narrow defined waist, wide shapely hips,
round glute curve, full soft thighs. Wardrobe: tight white ribbed sleeveless
crop top and fitted grey boy-short underwear; fabric conforms to chest, waist,
hips, and glutes.

Portfolio requirements: Row 1 full-body front/side/3-4 identity views,
including the exact top/bottom fit and hip-to-waist ratio. Row 2 medium side
profile and mirror-style poses centered on body curve, torso twist, smartphone
hand placement, and confident relaxed posture. Row 3 close-ups of face, hair,
phone, ribbed fabric texture, waistband, skin texture, and reflected city-light
environment. Camera and lighting: realistic smartphone snapshot, natural window
light, moderate contrast, high fidelity.

Preservation negatives: no slimming the torso, no reducing the bust, no
flattening glutes, no generic editorial fashion proportions, no distorted
hands, no smoothing/plastic skin, no naturalization of prominent features.
```

## Example: CCD Upper-Body Glamour Portfolio

```text
Adult Chinese woman in her 20s, seductive high-status portrait identity,
consistent across all 9 cells. Platinum/ash-blonde messy long hair, delicate
V-shaped face, refined features, sharp eyeliner, intense direct gaze, faint
controlled smile, confident cold glamour.

Anatomy and silhouette: extremely full prominent bust, visible cleavage,
hourglass upper-waist silhouette, slim shoulders, visible collarbones, composed
sensual posture. Wardrobe: pale peach high-neck stretch top, tight fabric
visibly stretched over the bust, collar framing the neck and collarbones.

Portfolio requirements: Row 1 full-body identity views despite the portrait
reference style, preserving the upper-body proportions and overall wardrobe.
Row 2 medium bust/waist portraits from low and eye-level angles with direct
gaze, collarbone line, fabric tension, and silhouette emphasis. Row 3 close-ups
of face, eyes, makeup, hair strands, neckline, fabric stretch, and skin texture.
Camera and lighting: low-resolution CCD/mobile-phone look, strong on-camera
flash, harsh shadow, dim moody setting, centered composition.

Preservation negatives: no full-body-only portfolio, no extra people, no text,
no watermark, no cartoon/anime look, no overexposure, no extreme wide shot, no
softening the bust/waist silhouette.
```

## User-Supplied Example Prompts

Use these as concrete examples for the model when creating adult women
portfolios. Adapt the structure to the requested character; preserve adult age
clarity and portfolio consistency.

```text
{
    "style_and_tech": "mobile phone photo, ultra-low resolution, old CCD camera aesthetic, strong on-camera flash photography, harsh flash shadows and highlights, grainy texture, dark dim environment, mysterious moody atmosphere, aspect ratio 4:7, centered composition, upper body portrait (bust shot), low angle shot looking up, from chest up including shoulders and collarbones",
    
    "subject_age_and_nationality": "20 years old, Chinese woman, top-tier seductive imperial sister, yujie aesthetic",
    
    "hair": "light platinum blonde / pale ash blonde long hair, very messy and scattered, disheveled strands falling naturally, several fine hair strands casually covering part of one eye and forehead",
    
    "face_shape_and_skin": "super mini sharp V-shaped face, extremely delicate and refined facial features, cold fair skin, smooth porcelain-like texture",
    
    "eyes": "large deep-set eyes, prominent aegyo-sal / under-eye fat pads, thin sharp black eyeliner, hazy dreamy eye expression, complex gaze — dangerous + lingering attachment + longing, staring directly and intensely into camera, confident yet slightly arrogant",
    
    "expression": "subtle delicate faint smile at the corner of the lips, appears gentle and soft on surface, but overall exudes scheming + high-cold + detached + fake-kindness aura, tsundere + seductive + dangerous vibe",
    
    "makeup": "light natural foundation, subtle contouring and highlighting on face (appropriate high points, not overdone), no excessive glow or dewy look",
    
    "nose_and_lips": "perfectly sculpted tall straight nose bridge and delicate tip like an art piece, natural lip shape with soft pink-nude lipstick",
    
    "clothing": "light apricot / pale peach thin high-neck top, tight-fitting stretch fabric, visibly strained and stretched over extremely full prominent bust, deep cleavage emphasized, fabric clinging to curves, high-neck collar framing the neck and collarbones",
    
    "body framing": "upper body focus, perfect exaggerated S-curve starting from bust and waist, slim shoulders, visible collarbones, hourglass silhouette from chest to upper waist, no full body or lower half in frame",
    
    "overall_character_vibe": "confident +Arrogant + dark and cold + cold + fake kindness, looks gentle but feels dangerously captivating",
    
    "negative": "--no full body, no lower body, no legs, no extra people, no text, no watermark, no strong rim light, no colorful background, no cartoon style, no anime, no heavy blur, no overexposure, no extreme wide shot"
  }--ar 4:7"
}
```

```text
{
"subject": {
"description": "Young woman with long, straight blonde hair and fair skin.",
"outfit": {
"headwear": "Large, fluffy pink faux-fur trapper hat (ushanka) with long ear flaps and drawstrings.",
"upper_body": "Pink, fuzzy, long-sleeved crop top, very short cut exposing the midriff and lower back.",
"lower_body": "High-cut pink and red lacy thong underwear."
},
"anatomy": {
"body_type": "Curvy and fit physique with a slim waist and significantly prominent, round buttocks.",
"skin": "Fair skin tone with realistic texture, visible softness, and natural skin details.",
"features": "Visible side profile of the chest showing fullness, accentuated gluteal curve."
}
},
"pose": {
"orientation": "Standing with back turned towards the camera (rear view).",
"head_position": "Head turned over the left shoulder, making direct eye contact with the viewer.",
"limbs": {
"left_arm": "Extended downwards, with the left hand fingers gently touching the left buttock/upper thigh area.",
"right_arm": "Bent at the elbow, hand not fully visible.",
"legs": "Standing straight, thighs touching."
},
"spine": "Slight arch in the lower back to accentuate the curvature of the glutes."
},
"environment": {
"setting": "Indoor room corner, possibly a converted residential space.",
"elements": [
"A tall, narrow window with a distinctive arched stone frame (resembling gothic or church architecture) on the left wall.",
"A white panel radiator mounted on the lower right wall.",
"Plain white or off-white painted walls."
],
"background_details": "A wooden side table corner visible in the bottom left, a lamp shade emitting warm light on the far left edge."
},
"camera": {
"shot_type": "Medium shot, framing from the mid-thighs to above the head.",
"perspective": "Eye-level to slightly low angle, emphasizing body curvature.",
"focal_length": "Standard lens, approx 35mm-50mm, slight wide-angle distortion typical of smartphone photography.",
"depth_of_field": "Deep depth of field, keeping both the subject and the immediate background features (window, radiator) in focus."
},
"lighting": {
"type": "Mixed lighting with strong direct flash.",
"characteristics": [
"Direct, hard flash illuminating the subject from the front-left perspective.",
"Sharp, distinct drop shadow of the subject cast onto the white wall to the right.",
"Warm ambient glow coming from the lamp on the left side, contrasting with the cooler flash tone."
]
},
"mood_and_expression": {
"emotion": "Alluring, confident, and flirty.",
"gaze": "Direct eye contact with a soft, seductive expression.",
"atmosphere": "Intimate and casual."
},
"style_and_realism": {
"aesthetic": "Amateur flash photography, candid social media style.",
"fidelity": "High-fidelity realism, capturing fabric textures (fuzziness of the hat and top) and skin texture accurately.",
"rendering": "Photorealistic, unpolished, raw visual style."
},
"colors_and_tone": {
"palette": "Dominant pinks (clothing), creamy whites (walls), fair skin tones.",
"contrast": "High contrast due to the direct flash.",
"white_balance": "Slightly cool from the flash, balanced by the warm yellow lamp light."
},
"quality_and_technical_details": {
"sharpness": "High sharpness on the subject.",
"noise": "Minimal grain.",
"lighting_artifacts": "Flash reflection and hard shadows are key technical elements."
},
"aspect_ratio_and_output": {
"ratio": "3:4",
"orientation": "Vertical portrait."
},
"controlnet": {
"pose_control": {
"model_type": "OpenPose",
"purpose": "Exact skeletal and pose lock",
"constraints": [
"preserve shoulder width",
"preserve hip angle",
"preserve spine curvature",
"preserve limb placement"
],
"recommended_weight": 1.0
},
"depth_control": {
"model_type": "MiDaS",
"purpose": "Depth, volume, and camera-to-body spatial lock",
"constraints": [
"preserve chest foreground dominance if present",
"prevent flat or compressed depth",
"maintain clear torso-to-background separation"
],
"recommended_weight": 0.8
}
},
"negative_prompt": {
"forbidden_elements": [
"anatomy normalization",
"body proportion averaging",
"smaller bust than reference",
"reduced chest volume",
"flattened or compressed breasts",
"tightened, lifted, or artificially supported breasts",
"slimmed torso",
"aesthetic proportion correction",
"beauty standard enforcement",
"dataset-average female anatomy",
"camera angles that reduce volume",
"wide-angle distortion not in reference",
"lens compression not in reference",
"cropping that removes volume",
"depth flattening",
"mirror selfies",
"phone-in-hand selfies",
"reflections",
"beautification filters",
"skin smoothing",
"plastic skin",
"airbrushed texture",
"stylized realism",
"editorial fashion proportions",
"more realistic reinterpretation",
"naturalization of prominent features"
]
}
}
```

```text
{
"subject": "Young woman with long, straight brunette hair and tanned skin, captured in a close-up outdoor shot. She is wearing a cream-colored crochet or fishnet bikini top over a solid beige lining. The anatomy is distinct with a very full, voluminous bust, showing deep cleavage and prominent forward projection natural to the pose. The skin texture is realistic with natural imperfections, subtle moles on the chest, and fine pores. She has a bright, engaging smile with visible white teeth. Her right hand is raised, holding a clear plastic iced coffee cup with the logo 'MALIBU FARM' printed in blue. She is sipping from a thin brown straw. Her fingernails are long with a French manicure (light tips).",
"pose": "Selfie-style close-up perspective. The subject is facing the camera directly with her head slightly tilted. Her right arm is bent upward to hold the drink near her mouth, while the straw rests between her lips. Her gaze is directed straight at the lens. The posture emphasizes the upper torso and chest volume relative to the camera distance.",
"environment": "A bright, sunny beach setting. The background features a vibrant blue sky filled with scattered white cumulus clouds. A horizon line of the ocean is visible in the distance, meeting a sandy beach area. The environment implies a warm, summer day at a coastal location.",
"camera": "Close-up shot, simulating a selfie angle or arm's length photography. Focal length is slightly wide (24mm-35mm equivalent) capturing the subject from the chest up. The depth of field is moderate; the subject is sharp, while the background sky and beach are clearly visible but slightly less focused than the foreground. High fidelity to the original framing.",
"lighting": "Bright, direct natural sunlight (hard lighting). Shadows are distinct, visible under the chin, nose, and casting downward from the bikini texture onto the skin. The lighting highlights the contours of the face, the gloss of the lips, and the volume of the chest. The sky provides a bright ambient fill.",
"mood_and_expression": "Happy, carefree, and relaxed. The expression is a genuine, confident smile, conveying a sense of enjoyment on a summer vacation. The vibe is casual and inviting.",
"style_and_realism": "Photorealistic, high-definition smartphone photography aesthetic. Sharp focus on facial features and the texture of the crochet bikini. Colors are vivid but natural. No artistic stylization; strictly realistic capture of the moment.",
"colors_and_tone": "Natural and vibrant palette. Dominant colors include the deep blue of the sky, bright white clouds, warm tan skin tones, cream/beige of the bikini, and the dark brown liquid in the cup. High contrast due to bright sunlight.",
"quality_and_technical_details": "4K resolution, sharp details. Texture of the fishnet/crochet fabric is clearly defined. The 'MALIBU FARM' text on the cup is legible. Grains of sand are stuck to the bottom exterior of the plastic cup, adding textural realism. Water condensation or texture on the plastic cup is visible.",
"aspect_ratio_and_output": "3:4",
"controlnet": {
"pose_control": {
"model_type": "OpenPose",
"purpose": "Exact skeletal and pose lock",
"constraints": [
"preserve shoulder width",
"preserve hip angle",
"preserve spine curvature",
"preserve limb placement",
"lock hand position holding cup",
"lock head tilt"
],
"recommended_weight": 1.0
},
"depth_control": {
"model_type": "MiDaS",
"purpose": "Depth, volume, and camera-to-body spatial lock",
"constraints": [
"preserve chest foreground dominance",
"maintain distinct volume of cup relative to face",
"prevent flat or compressed depth",
"maintain clear torso-to-background separation"
],
"recommended_weight": 0.8
}
},
"negative_prompt": {
"forbidden_elements": [
"anatomy normalization",
"body proportion averaging",
"smaller bust than reference",
"reduced chest volume",
"flattened or compressed breasts",
"tightened, lifted, or artificially supported breasts",
"slimmed torso",
"aesthetic proportion correction",
"beauty standard enforcement",
"dataset-average female anatomy",
"camera angles that reduce volume",
"wide-angle distortion not in reference",
"lens compression not in reference",
"cropping that removes volume",
"depth flattening",
"beautification filters",
"skin smoothing",
"plastic skin",
"airbrushed texture",
"stylized realism",
"editorial fashion proportions",
"naturalization of prominent features",
"missing cup",
"missing straw",
"missing logo on cup",
"clean cup bottom (must have sand)"
]
}
}
```

## Keyframe Carry-Through

When generating keyframes for this character, repeat a compact identity line in
the `instruction`, not only in the keyframe body:

```text
Preserve [Name]'s adult supermodel-level beauty, voluptuous full-bust/defined-
waist/shapely-hips silhouette, confident sensual posture, and exact wardrobe:
[wardrobe]. [Frame-specific action and composition.]
```
