// A simple Bengali to Latin (Banglish) transliterator

const bnMap: Record<string, string> = {
  // Vowels
  'অ': 'o', 'আ': 'a', 'ই': 'i', 'ঈ': 'ee', 'উ': 'u', 'ঊ': 'oo',
  'ঋ': 'ri', 'এ': 'e', 'ঐ': 'oi', 'ও': 'o', 'ঔ': 'ou',
  
  // Consonants
  'ক': 'k', 'খ': 'kh', 'গ': 'g', 'ঘ': 'gh', 'ঙ': 'ng',
  'চ': 'ch', 'ছ': 'chh', 'জ': 'j', 'ঝ': 'jh', 'ঞ': 'n',
  'ট': 't', 'ঠ': 'th', 'ড': 'd', 'ঢ': 'dh', 'ণ': 'n',
  'ত': 't', 'থ': 'th', 'দ': 'd', 'ধ': 'dh', 'ন': 'n',
  'প': 'p', 'ফ': 'f', 'ব': 'b', 'ভ': 'bh', 'ম': 'm',
  'য': 'j', 'র': 'r', 'ল': 'l',
  'শ': 'sh', 'ষ': 'sh', 'স': 's', 'হ': 'h',
  'ড়': 'r', 'ঢ়': 'rh', 'য়': 'y',
  
  // Modifiers
  'ৎ': 't', 'ং': 'ng', 'ঃ': 'h', 'ঁ': 'n',

  // Vowel signs (Matras)
  'া': 'a', 'ি': 'i', 'ী': 'ee', 'ু': 'u', 'ূ': 'oo',
  'ৃ': 'ri', 'ে': 'e', 'ৈ': 'oi', 'ো': 'o', 'ৌ': 'ou',
  '্': '', // Hasant removes inherent vowel, but since we are simple mapping, we just strip it
};

export function transliterateBanglish(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    // If it's a known Bengali character, map it
    if (bnMap[char] !== undefined) {
      result += bnMap[char];
    } else {
      // Keep punctuation, spaces, and English letters as is
      result += char;
    }
  }
  
  // Clean up common weird phonetic patterns due to simple mapping
  // e.g. capitalize first letter of sentence
  result = result.replace(/([.?!])\s*([a-z])/g, (_, p1, p2) => p1 + ' ' + p2.toUpperCase());
  if (result.length > 0) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }
  
  return result;
}
