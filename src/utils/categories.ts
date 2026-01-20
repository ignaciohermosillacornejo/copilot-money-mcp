/**
 * Plaid category mappings for human-readable category names.
 *
 * Based on Plaid's transaction categorization system.
 * See: https://plaid.com/docs/api/products/transactions/#categoriesget
 */

/**
 * Mapping of Plaid category IDs to human-readable names.
 *
 * Format: "primary_detailed" -> "Primary > Detailed"
 * Some IDs are numeric (Plaid legacy format), others are snake_case.
 */
export const CATEGORY_NAMES: Record<string, string> = {
  // ============================================
  // INCOME CATEGORIES
  // ============================================
  income: 'Income',
  income_dividends: 'Income > Dividends',
  income_interest_earned: 'Income > Interest Earned',
  income_retirement_pension: 'Income > Retirement Pension',
  income_tax_refund: 'Income > Tax Refund',
  income_unemployment: 'Income > Unemployment',
  income_wages: 'Income > Wages',
  income_other_income: 'Income > Other Income',

  // ============================================
  // TRANSFER CATEGORIES
  // ============================================
  transfer_in: 'Transfer In',
  transfer_in_account_transfer: 'Transfer In > Account Transfer',
  transfer_in_cash_advances_and_loans: 'Transfer In > Cash Advances & Loans',
  transfer_in_deposit: 'Transfer In > Deposit',
  transfer_in_investment_and_retirement_funds: 'Transfer In > Investment & Retirement Funds',
  transfer_in_savings: 'Transfer In > Savings',
  transfer_in_other_transfer_in: 'Transfer In > Other',

  transfer_out: 'Transfer Out',
  transfer_out_account_transfer: 'Transfer Out > Account Transfer',
  transfer_out_investment_and_retirement_funds: 'Transfer Out > Investment & Retirement Funds',
  transfer_out_savings: 'Transfer Out > Savings',
  transfer_out_withdrawal: 'Transfer Out > Withdrawal',
  transfer_out_other_transfer_out: 'Transfer Out > Other',

  // ============================================
  // LOAN PAYMENTS
  // ============================================
  loan_payments: 'Loan Payments',
  loan_payments_car_payment: 'Loan Payments > Car Payment',
  loan_payments_credit_card_payment: 'Loan Payments > Credit Card Payment',
  loan_payments_personal_loan_payment: 'Loan Payments > Personal Loan',
  loan_payments_mortgage_payment: 'Loan Payments > Mortgage',
  loan_payments_student_loan_payment: 'Loan Payments > Student Loan',
  loan_payments_other_payment: 'Loan Payments > Other',

  // ============================================
  // BANK FEES
  // ============================================
  bank_fees: 'Bank Fees',
  bank_fees_atm_fees: 'Bank Fees > ATM Fees',
  bank_fees_foreign_transaction_fees: 'Bank Fees > Foreign Transaction Fees',
  bank_fees_insufficient_funds: 'Bank Fees > Insufficient Funds',
  bank_fees_interest_charge: 'Bank Fees > Interest Charge',
  bank_fees_overdraft_fees: 'Bank Fees > Overdraft Fees',
  bank_fees_other_bank_fees: 'Bank Fees > Other',

  // ============================================
  // ENTERTAINMENT
  // ============================================
  entertainment: 'Entertainment',
  entertainment_casinos_and_gambling: 'Entertainment > Casinos & Gambling',
  entertainment_music_and_audio: 'Entertainment > Music & Audio',
  entertainment_sporting_events_amusement_parks_and_museums: 'Entertainment > Events & Attractions',
  entertainment_tv_and_movies: 'Entertainment > TV & Movies',
  entertainment_video_games: 'Entertainment > Video Games',
  entertainment_other_entertainment: 'Entertainment > Other',

  // ============================================
  // FOOD AND DRINK
  // ============================================
  food_and_drink: 'Food & Drink',
  food_dining: 'Food & Drink',
  food_and_drink_beer_wine_and_liquor: 'Food & Drink > Alcohol',
  food_and_drink_coffee: 'Food & Drink > Coffee',
  food_and_drink_fast_food: 'Food & Drink > Fast Food',
  food_and_drink_groceries: 'Food & Drink > Groceries',
  food_and_drink_restaurant: 'Food & Drink > Restaurants',
  food_and_drink_vending_machines: 'Food & Drink > Vending Machines',
  food_and_drink_other_food_and_drink: 'Food & Drink > Other',

  // Shorthand versions
  groceries: 'Groceries',
  restaurants: 'Restaurants',
  coffee_shops: 'Coffee Shops',
  fast_food: 'Fast Food',
  alcohol_bars: 'Alcohol & Bars',

  // ============================================
  // GENERAL MERCHANDISE
  // ============================================
  general_merchandise: 'Shopping',
  general_merchandise_bookstores_and_newsstands: 'Shopping > Books & News',
  general_merchandise_clothing_and_accessories: 'Shopping > Clothing',
  general_merchandise_convenience_stores: 'Shopping > Convenience Stores',
  general_merchandise_department_stores: 'Shopping > Department Stores',
  general_merchandise_discount_stores: 'Shopping > Discount Stores',
  general_merchandise_electronics: 'Shopping > Electronics',
  general_merchandise_gifts_and_novelties: 'Shopping > Gifts',
  general_merchandise_office_supplies: 'Shopping > Office Supplies',
  general_merchandise_online_marketplaces: 'Shopping > Online Marketplaces',
  general_merchandise_pet_supplies: 'Shopping > Pet Supplies',
  general_merchandise_sporting_goods: 'Shopping > Sporting Goods',
  general_merchandise_superstores: 'Shopping > Superstores',
  general_merchandise_tobacco_and_vape: 'Shopping > Tobacco & Vape',
  general_merchandise_other_general_merchandise: 'Shopping > Other',

  // Shorthand versions
  shopping: 'Shopping',
  clothing: 'Clothing',
  electronics: 'Electronics',

  // ============================================
  // HOME IMPROVEMENT
  // ============================================
  home_improvement: 'Home Improvement',
  home_improvement_furniture: 'Home Improvement > Furniture',
  home_improvement_hardware: 'Home Improvement > Hardware',
  home_improvement_repair_and_maintenance: 'Home Improvement > Repair',
  home_improvement_security: 'Home Improvement > Security',
  home_improvement_other_home_improvement: 'Home Improvement > Other',

  // ============================================
  // MEDICAL
  // ============================================
  medical: 'Medical',
  medical_dental_care: 'Medical > Dental Care',
  medical_eye_care: 'Medical > Eye Care',
  medical_nursing_care: 'Medical > Nursing Care',
  medical_pharmacies_and_supplements: 'Medical > Pharmacies',
  medical_primary_care: 'Medical > Primary Care',
  medical_veterinary_services: 'Medical > Veterinary',
  medical_other_medical: 'Medical > Other',

  // Shorthand versions
  healthcare: 'Healthcare',
  pharmacy: 'Pharmacy',
  doctor: 'Doctor',
  dentist: 'Dentist',

  // ============================================
  // PERSONAL CARE
  // ============================================
  personal_care: 'Personal Care',
  personal_care_gyms_and_fitness_centers: 'Personal Care > Gym & Fitness',
  personal_care_hair_and_beauty: 'Personal Care > Hair & Beauty',
  personal_care_laundry_and_dry_cleaning: 'Personal Care > Laundry',
  personal_care_other_personal_care: 'Personal Care > Other',

  // Shorthand versions
  gym: 'Gym & Fitness',
  spa: 'Spa & Beauty',

  // ============================================
  // GENERAL SERVICES
  // ============================================
  general_services: 'Services',
  general_services_accounting_and_financial_planning: 'Services > Financial Planning',
  general_services_automotive: 'Services > Automotive',
  general_services_childcare: 'Services > Childcare',
  general_services_consulting_and_legal: 'Services > Legal & Consulting',
  general_services_education: 'Services > Education',
  general_services_insurance: 'Services > Insurance',
  general_services_postage_and_shipping: 'Services > Shipping',
  general_services_storage: 'Services > Storage',
  general_services_other_general_services: 'Services > Other',

  // Shorthand versions
  education: 'Education',
  insurance: 'Insurance',
  legal: 'Legal Services',

  // ============================================
  // GOVERNMENT AND NON-PROFIT
  // ============================================
  government_and_non_profit: 'Government & Non-Profit',
  government_and_non_profit_donations: 'Donations',
  government_and_non_profit_government_departments_and_agencies: 'Government',
  government_and_non_profit_tax_payment: 'Tax Payment',
  government_and_non_profit_other_government_and_non_profit: 'Government & Non-Profit > Other',

  // Shorthand versions
  taxes: 'Taxes',
  donations: 'Donations',
  charity: 'Charity',

  // ============================================
  // TRANSPORTATION
  // ============================================
  transportation: 'Transportation',
  transportation_bikes_and_scooters: 'Transportation > Bikes & Scooters',
  transportation_gas: 'Transportation > Gas',
  transportation_parking: 'Transportation > Parking',
  transportation_public_transit: 'Transportation > Public Transit',
  transportation_taxis_and_ride_shares: 'Transportation > Rideshare',
  transportation_tolls: 'Transportation > Tolls',
  transportation_other_transportation: 'Transportation > Other',

  // Shorthand versions
  gas_stations: 'Gas',
  parking: 'Parking',
  public_transit: 'Public Transit',
  rideshare: 'Rideshare',
  uber: 'Rideshare',
  lyft: 'Rideshare',

  // ============================================
  // TRAVEL
  // ============================================
  travel: 'Travel',
  travel_flights: 'Travel > Flights',
  travel_lodging: 'Travel > Lodging',
  travel_rental_cars: 'Travel > Rental Cars',
  travel_other_travel: 'Travel > Other',

  // Shorthand versions
  airlines: 'Airlines',
  hotels: 'Hotels',
  car_rental: 'Car Rental',

  // ============================================
  // RENT AND UTILITIES
  // ============================================
  rent_and_utilities: 'Rent & Utilities',
  rent_and_utilities_gas_and_electricity: 'Utilities > Gas & Electric',
  rent_and_utilities_internet_and_cable: 'Utilities > Internet & Cable',
  rent_and_utilities_rent: 'Rent',
  rent_and_utilities_sewage_and_waste_management: 'Utilities > Sewage & Waste',
  rent_and_utilities_telephone: 'Utilities > Phone',
  rent_and_utilities_water: 'Utilities > Water',
  rent_and_utilities_other_utilities: 'Utilities > Other',

  // Shorthand versions
  rent: 'Rent',
  utilities: 'Utilities',
  phone: 'Phone',
  internet: 'Internet',
  cable: 'Cable TV',

  // ============================================
  // NUMERIC PLAID CATEGORY IDs (Legacy Format)
  // These are hierarchical: PPPPSSSS format
  // ============================================

  // Bank Fees (10000000)
  '10000000': 'Bank Fees',
  '10001000': 'Bank Fees > Overdraft',
  '10002000': 'Bank Fees > ATM',
  '10003000': 'Bank Fees > Late Payment',
  '10004000': 'Bank Fees > Fraud Dispute',
  '10005000': 'Bank Fees > Foreign Transaction',
  '10006000': 'Bank Fees > Wire Transfer',
  '10007000': 'Bank Fees > Insufficient Funds',
  '10008000': 'Bank Fees > Cash Advance',
  '10009000': 'Bank Fees > Excess Activity',

  // Community (11000000)
  '11000000': 'Community',
  '11001000': 'Community > Animal Shelter',
  '11002000': 'Community > Assisted Living',
  '11003000': 'Community > Cemetery',
  '11004000': 'Community > Courts',
  '11005000': 'Community > Day Care',
  '11006000': 'Community > Disabled Support',
  '11007000': 'Community > Drug & Alcohol',
  '11008000': 'Community > Education',
  '11009000': 'Community > Government',
  '11010000': 'Community > Library',
  '11011000': 'Community > Organizations',
  '11012000': 'Community > Post Office',
  '11013000': 'Community > Public Safety',
  '11014000': 'Community > Religious',
  '11015000': 'Community > Senior Services',
  '11016000': 'Community > Youth Organizations',

  // Food and Drink (13000000)
  '13000000': 'Food & Drink',
  '13001000': 'Food & Drink > Bar',
  '13001001': 'Food & Drink > Wine Bar',
  '13001002': 'Food & Drink > Sports Bar',
  '13001003': 'Food & Drink > Hotel Lounge',
  '13002000': 'Food & Drink > Brewery',
  '13003000': 'Food & Drink > Cafe',
  '13004000': 'Food & Drink > Caterer',
  '13005000': 'Food & Drink > Restaurant',
  '13005001': 'Food & Drink > American',
  '13005002': 'Food & Drink > Asian',
  '13005003': 'Food & Drink > BBQ',
  '13005004': 'Food & Drink > Bakery',
  '13005005': 'Food & Drink > Breakfast',
  '13005006': 'Food & Drink > Caribbean',
  '13005007': 'Food & Drink > Chinese',
  '13005008': 'Food & Drink > Coffee Shop',
  '13005009': 'Food & Drink > Deli',
  '13005010': 'Food & Drink > Dessert',
  '13005011': 'Food & Drink > Diner',
  '13005012': 'Food & Drink > Fast Food',
  '13005013': 'Food & Drink > French',
  '13005014': 'Food & Drink > Greek',
  '13005015': 'Food & Drink > Indian',
  '13005016': 'Food & Drink > Italian',
  '13005017': 'Food & Drink > Japanese',
  '13005018': 'Food & Drink > Juice Bar',
  '13005019': 'Food & Drink > Korean',
  '13005020': 'Food & Drink > Latin American',
  '13005021': 'Food & Drink > Mediterranean',
  '13005022': 'Food & Drink > Mexican',
  '13005023': 'Food & Drink > Middle Eastern',
  '13005024': 'Food & Drink > Pizza',
  '13005025': 'Food & Drink > Seafood',
  '13005026': 'Food & Drink > Thai',
  '13005027': 'Food & Drink > Turkish',
  '13005028': 'Food & Drink > Vegan',
  '13005029': 'Food & Drink > Vegetarian',
  '13005030': 'Food & Drink > Vietnamese',
  '13005031': 'Food & Drink > Wings',
  '13005032': 'Food & Drink > Burgers',
  '13005033': 'Food & Drink > Hot Dogs',
  '13005034': 'Food & Drink > Sandwiches',
  '13005035': 'Food & Drink > Sushi',
  '13005036': 'Food & Drink > Steak',
  '13005037': 'Food & Drink > Soul Food',
  '13005038': 'Food & Drink > Gastropub',
  '13005039': 'Food & Drink > Donuts',
  '13005040': 'Food & Drink > Frozen Yogurt',
  '13005041': 'Food & Drink > Ice Cream',
  '13005042': 'Food & Drink > Food Truck',
  '13005043': 'Food & Drink > Buffet',
  '13005044': 'Food & Drink > Dim Sum',
  '13005045': 'Food & Drink > Crepes',
  '13005046': 'Food & Drink > Falafel',
  '13005047': 'Food & Drink > Cuban',
  '13005048': 'Food & Drink > Hawaiian',
  '13005049': 'Food & Drink > Internet Cafe',
  '13005050': 'Food & Drink > Tea Room',
  '13005051': 'Food & Drink > Winery',
  '13005052': 'Food & Drink > Ramen',
  '13005053': 'Food & Drink > Noodles',
  '13005054': 'Food & Drink > Smoothie',
  '13005055': 'Food & Drink > Salad',
  '13005056': 'Food & Drink > Tapas',
  '13005057': 'Food & Drink > Fondue',
  '13005058': 'Food & Drink > Peruvian',
  '13005059': 'Food & Drink > German',

  // Healthcare (14000000)
  '14000000': 'Healthcare',
  '14001000': 'Healthcare > Dentist',
  '14001001': 'Healthcare > Dentist > Cosmetic',
  '14001002': 'Healthcare > Dentist > General',
  '14001003': 'Healthcare > Dentist > Oral Surgery',
  '14001004': 'Healthcare > Dentist > Orthodontics',
  '14001005': 'Healthcare > Dentist > Pediatric',
  '14001006': 'Healthcare > Dentist > Periodontics',
  '14002000': 'Healthcare > Doctor',
  '14002001': 'Healthcare > Doctor > General Practice',
  '14002002': 'Healthcare > Doctor > Family Medicine',
  '14002003': 'Healthcare > Doctor > Internal Medicine',
  '14002004': 'Healthcare > Doctor > Dermatology',
  '14002005': 'Healthcare > Doctor > Cardiologist',
  '14002006': 'Healthcare > Doctor > OB-GYN',
  '14002007': 'Healthcare > Doctor > Pediatrician',
  '14002008': 'Healthcare > Doctor > Psychiatrist',
  '14002009': 'Healthcare > Doctor > Optometrist',
  '14003000': 'Healthcare > Hospital',
  '14003001': 'Healthcare > Hospital > Emergency',
  '14003002': 'Healthcare > Hospital > Medical Center',
  '14003003': 'Healthcare > Hospital > Urgent Care',
  '14004000': 'Healthcare > Blood Bank',
  '14005000': 'Healthcare > Labs',
  '14006000': 'Healthcare > Medical Supplies',
  '14007000': 'Healthcare > Mental Health',
  '14008000': 'Healthcare > Nursing Home',
  '14009000': 'Healthcare > Pharmacy',
  '14010000': 'Healthcare > Physical Therapy',
  '14011000': 'Healthcare > Vision Care',

  // Interest (15000000)
  '15000000': 'Interest',
  '15001000': 'Interest > Interest Earned',
  '15002000': 'Interest > Interest Charged',

  // Payment (16000000)
  '16000000': 'Payment',
  '16001000': 'Payment > Credit Card',
  '16002000': 'Payment > Rent',
  '16003000': 'Payment > Loan',

  // Recreation (17000000)
  '17000000': 'Recreation',
  '17001000': 'Recreation > Arts & Entertainment',
  '17001001': 'Recreation > Aquarium',
  '17001002': 'Recreation > Arcade',
  '17001003': 'Recreation > Art Gallery',
  '17001004': 'Recreation > Botanical Garden',
  '17001005': 'Recreation > Concert',
  '17001006': 'Recreation > Fair',
  '17001007': 'Recreation > Movie Theater',
  '17001008': 'Recreation > Museum',
  '17001009': 'Recreation > Music Venue',
  '17001010': 'Recreation > Night Club',
  '17001011': 'Recreation > Opera House',
  '17001012': 'Recreation > Performing Arts',
  '17001013': 'Recreation > Planetarium',
  '17001014': 'Recreation > Psychic',
  '17001015': 'Recreation > Stadium',
  '17001016': 'Recreation > Zoo',
  '17002000': 'Recreation > Amusement Park',
  '17003000': 'Recreation > Athletic Fields',
  '17004000': 'Recreation > Beaches',
  '17005000': 'Recreation > Campgrounds',
  '17006000': 'Recreation > Canoes & Kayaks',
  '17007000': 'Recreation > Country Club',
  '17008000': 'Recreation > Dance Studio',
  '17009000': 'Recreation > Go Kart Track',
  '17010000': 'Recreation > Golf Course',
  '17011000': 'Recreation > Gun Range',
  '17012000': 'Recreation > Gymnastics',
  '17013000': 'Recreation > Gym',
  '17014000': 'Recreation > Hot Springs',
  '17015000': 'Recreation > Lakes',
  '17016000': 'Recreation > Laser Tag',
  '17017000': 'Recreation > Miniature Golf',
  '17018000': 'Recreation > National Parks',
  '17019000': 'Recreation > Outdoors',
  '17020000': 'Recreation > Paintball',
  '17021000': 'Recreation > Parks',
  '17022000': 'Recreation > Personal Training',
  '17023000': 'Recreation > Playgrounds',
  '17024000': 'Recreation > Rafting',
  '17025000': 'Recreation > Recreation Center',
  '17026000': 'Recreation > Roller Rink',
  '17027000': 'Recreation > Running',
  '17028000': 'Recreation > Skating Rink',
  '17029000': 'Recreation > Skydiving',
  '17030000': 'Recreation > Snow Sports',
  '17031000': 'Recreation > Spa',
  '17032000': 'Recreation > Sports Club',
  '17033000': 'Recreation > Swim School',
  '17034000': 'Recreation > Swimming Pool',
  '17035000': 'Recreation > Tennis Court',
  '17036000': 'Recreation > Theme Park',
  '17037000': 'Recreation > Water Park',
  '17038000': 'Recreation > Yoga Studio',

  // Service (18000000)
  '18000000': 'Service',
  '18001000': 'Service > Advertising & Marketing',
  '18002000': 'Service > Art Restoration',
  '18003000': 'Service > Audio Visual',
  '18004000': 'Service > Auto Service',
  '18004001': 'Service > Auto Body Shop',
  '18004002': 'Service > Auto Dealer',
  '18004003': 'Service > Auto Glass',
  '18004004': 'Service > Auto Parts',
  '18004005': 'Service > Auto Tires',
  '18004006': 'Service > Car Wash',
  '18004007': 'Service > Mechanic',
  '18004008': 'Service > Oil Change',
  '18004009': 'Service > Parking',
  '18004010': 'Service > Smog Check',
  '18004011': 'Service > Towing',
  '18005000': 'Service > Baggage Service',
  '18006000': 'Service > Bail Bonds',
  '18007000': 'Service > Business Services',
  '18007001': 'Service > Consulting',
  '18007002': 'Service > Bookkeeping',
  '18007003': 'Service > Printing',
  '18007004': 'Service > Shipping',
  '18008000': 'Service > Cable',
  '18009000': 'Service > Chambers Of Commerce',
  '18010000': 'Service > Cleaning',
  '18010001': 'Service > Carpet Cleaning',
  '18010002': 'Service > Housekeeping',
  '18010003': 'Service > Laundromat',
  '18010004': 'Service > Dry Cleaning',
  '18011000': 'Service > Computer Repair',
  '18012000': 'Service > Contractor',
  '18012001': 'Service > Architect',
  '18012002': 'Service > Carpenter',
  '18012003': 'Service > Electrician',
  '18012004': 'Service > Flooring',
  '18012005': 'Service > Garage Doors',
  '18012006': 'Service > General Contractor',
  '18012007': 'Service > Gutters',
  '18012008': 'Service > Handyman',
  '18012009': 'Service > HVAC',
  '18012010': 'Service > Landscaping',
  '18012011': 'Service > Masonry',
  '18012012': 'Service > Painter',
  '18012013': 'Service > Plumber',
  '18012014': 'Service > Pool Cleaner',
  '18012015': 'Service > Remodeling',
  '18012016': 'Service > Roofing',
  '18012017': 'Service > Siding',
  '18012018': 'Service > Solar',
  '18012019': 'Service > Tree Service',
  '18012020': 'Service > Windows',
  '18013000': 'Service > Dating',
  '18014000': 'Service > Employment Agencies',
  '18015000': 'Service > Entertainment',
  '18016000': 'Service > Event Services',
  '18017000': 'Service > Financial',
  '18017001': 'Service > ATM',
  '18017002': 'Service > Accounting',
  '18017003': 'Service > Bank',
  '18017004': 'Service > Check Cashing',
  '18017005': 'Service > Credit Union',
  '18017006': 'Service > Financial Planner',
  '18017007': 'Service > Loan',
  '18017008': 'Service > Money Order',
  '18017009': 'Service > Mortgage Broker',
  '18017010': 'Service > Payroll',
  '18017011': 'Service > Tax Preparation',
  '18017012': 'Service > Wire Transfer',
  '18018000': 'Service > Funeral Services',
  '18019000': 'Service > Home Services',
  '18019001': 'Service > Exterminator',
  '18019002': 'Service > Home Security',
  '18019003': 'Service > Interior Design',
  '18019004': 'Service > Locksmith',
  '18019005': 'Service > Moving',
  '18019006': 'Service > Storage',
  '18020000': 'Service > Immigration',
  '18021000': 'Service > Import Export',
  '18022000': 'Service > Insurance',
  '18022001': 'Service > Auto Insurance',
  '18022002': 'Service > Health Insurance',
  '18022003': 'Service > Home Insurance',
  '18022004': 'Service > Life Insurance',
  '18023000': 'Service > Internet',
  '18024000': 'Service > Leather',
  '18025000': 'Service > Legal',
  '18025001': 'Service > Attorney',
  '18025002': 'Service > Bail Bonds',
  '18025003': 'Service > Notary',
  '18026000': 'Service > Logging & Sawmills',
  '18027000': 'Service > Management',
  '18028000': 'Service > Manufacturing',
  '18029000': 'Service > Massage',
  '18030000': 'Service > Media',
  '18030001': 'Service > Broadcasting',
  '18030002': 'Service > Newspapers',
  '18030003': 'Service > Publishing',
  '18031000': 'Service > Mining',
  '18032000': 'Service > News Reporting',
  '18033000': 'Service > Oil & Gas',
  '18034000': 'Service > Packaging',
  '18035000': 'Service > Personal Care',
  '18035001': 'Service > Barber',
  '18035002': 'Service > Beauty Salon',
  '18035003': 'Service > Day Spa',
  '18035004': 'Service > Nail Salon',
  '18035005': 'Service > Tanning Salon',
  '18035006': 'Service > Tattoo Parlor',
  '18036000': 'Service > Pest Control',
  '18037000': 'Service > Pet Services',
  '18037001': 'Service > Dog Walker',
  '18037002': 'Service > Grooming',
  '18037003': 'Service > Kennel',
  '18037004': 'Service > Pet Sitting',
  '18037005': 'Service > Veterinarian',
  '18038000': 'Service > Photography',
  '18039000': 'Service > Plastics',
  '18040000': 'Service > Printing',
  '18041000': 'Service > Real Estate',
  '18041001': 'Service > Apartments',
  '18041002': 'Service > Commercial Real Estate',
  '18041003': 'Service > Property Management',
  '18041004': 'Service > Real Estate Agent',
  '18041005': 'Service > Title Company',
  '18042000': 'Service > Refrigeration & Ice',
  '18043000': 'Service > Renewable Energy',
  '18044000': 'Service > Repair',
  '18044001': 'Service > Appliance Repair',
  '18044002': 'Service > Electronics Repair',
  '18044003': 'Service > Furniture Repair',
  '18044004': 'Service > Shoe Repair',
  '18044005': 'Service > Watch Repair',
  '18045000': 'Service > Research',
  '18046000': 'Service > Security',
  '18047000': 'Service > Tailoring',
  '18048000': 'Service > Telecommunication',
  '18048001': 'Service > Phone',
  '18048002': 'Service > Utilities',
  '18049000': 'Service > Translation',
  '18050000': 'Service > Utilities',
  '18050001': 'Service > Electric',
  '18050002': 'Service > Gas',
  '18050003': 'Service > Water',
  '18050004': 'Service > Sanitary & Waste',
  '18051000': 'Service > Veterinarian',
  '18052000': 'Service > Water Treatment',
  '18053000': 'Service > Web Design',
  '18054000': 'Service > Welding',
  '18055000': 'Service > Forestry',
  '18056000': 'Service > Fishing',
  '18057000': 'Service > Agriculture',
  '18058000': 'Service > Art & Entertainment',

  // Shops (19000000)
  '19000000': 'Shops',
  '19001000': 'Shops > Adult',
  '19002000': 'Shops > Antiques',
  '19003000': 'Shops > Art & Craft',
  '19003001': 'Shops > Arts & Crafts',
  '19003002': 'Shops > Fabrics',
  '19003003': 'Shops > Framing',
  '19003004': 'Shops > Sewing',
  '19004000': 'Shops > Auction Houses',
  '19005000': 'Shops > Auto',
  '19005001': 'Shops > Boat Dealer',
  '19005002': 'Shops > Car Dealer',
  '19005003': 'Shops > Motorcycle Dealer',
  '19005004': 'Shops > RV Dealer',
  '19005005': 'Shops > Truck Dealer',
  '19006000': 'Shops > Baby',
  '19007000': 'Shops > Beauty Supply',
  '19008000': 'Shops > Bicycles',
  '19009000': 'Shops > Boat',
  '19010000': 'Shops > Bookstores',
  '19011000': 'Shops > Bridal',
  '19012000': 'Shops > CBD',
  '19013000': 'Shops > Cards & Stationery',
  '19014000': 'Shops > Children',
  '19015000': 'Shops > Clothing & Accessories',
  '19015001': 'Shops > Boutique',
  '19015002': "Shops > Men's Clothing",
  '19015003': "Shops > Women's Clothing",
  '19015004': "Shops > Kids' Clothing",
  '19015005': 'Shops > Shoes',
  '19015006': 'Shops > Sunglasses',
  '19015007': 'Shops > Vintage & Thrift',
  '19016000': 'Shops > Computers & Electronics',
  '19016001': 'Shops > Cameras',
  '19016002': 'Shops > Computers',
  '19016003': 'Shops > Electronics',
  '19016004': 'Shops > Games',
  '19016005': 'Shops > Mobile Phones',
  '19017000': 'Shops > Convenience',
  '19018000': 'Shops > Costumes',
  '19019000': 'Shops > Dance & Music',
  '19019001': 'Shops > Dance Wear',
  '19019002': 'Shops > Music',
  '19020000': 'Shops > Department Stores',
  '19021000': 'Shops > Digital Purchase',
  '19022000': 'Shops > Discount',
  '19023000': 'Shops > Electrical Equipment',
  '19024000': 'Shops > Flea Markets',
  '19025000': 'Shops > Florists',
  '19026000': 'Shops > Food & Beverage',
  '19026001': 'Shops > Bakery',
  '19026002': 'Shops > Candy Store',
  '19026003': 'Shops > Cheese Shop',
  '19026004': 'Shops > Coffee & Tea',
  '19026005': 'Shops > Deli',
  '19026006': 'Shops > Farmers Market',
  '19026007': 'Shops > Fish Market',
  '19026008': 'Shops > Gourmet',
  '19026009': 'Shops > Health Food',
  '19026010': 'Shops > Liquor Store',
  '19026011': 'Shops > Meat & Fish',
  '19026012': 'Shops > Supermarket',
  '19026013': 'Shops > Wine Shop',
  '19027000': 'Shops > Fuel',
  '19028000': 'Shops > Furniture & Home',
  '19028001': 'Shops > Appliances',
  '19028002': 'Shops > Bath',
  '19028003': 'Shops > Bed & Bath',
  '19028004': 'Shops > Furniture',
  '19028005': 'Shops > Home Decor',
  '19028006': 'Shops > Kitchen',
  '19028007': 'Shops > Lighting',
  '19028008': 'Shops > Mattresses',
  '19028009': 'Shops > Rugs & Carpets',
  '19029000': 'Shops > Garden',
  '19030000': 'Shops > Gift Shops',
  '19031000': 'Shops > Hardware',
  '19032000': 'Shops > Health & Wellness',
  '19033000': 'Shops > Hobby',
  '19033001': 'Shops > Collectibles',
  '19033002': 'Shops > Comic Books',
  '19033003': 'Shops > Magic Supplies',
  '19033004': 'Shops > Model Trains',
  '19033005': 'Shops > Stamps & Coins',
  '19034000': 'Shops > Hunting & Fishing',
  '19035000': 'Shops > Jewelry & Watches',
  '19036000': 'Shops > Luggage',
  '19037000': 'Shops > Marijuana',
  '19038000': 'Shops > Maternity',
  '19039000': 'Shops > Military Surplus',
  '19040000': 'Shops > Motorcycles & Scooters',
  '19041000': 'Shops > Musical Instruments',
  '19042000': 'Shops > Newsstands',
  '19043000': 'Shops > Office Supplies',
  '19044000': 'Shops > Optical',
  '19045000': 'Shops > Outdoor',
  '19046000': 'Shops > Outlet',
  '19047000': 'Shops > Pawn Shops',
  '19048000': 'Shops > Pets',
  '19049000': 'Shops > Pharmacy',
  '19050000': 'Shops > Photos & Prints',
  '19051000': 'Shops > Pool & Patio',
  '19052000': 'Shops > Record Stores',
  '19053000': 'Shops > Religious',
  '19054000': 'Shops > Shoe',
  '19055000': 'Shops > Smoke',
  '19056000': 'Shops > Sporting Goods',
  '19057000': 'Shops > Supermarket',
  '19058000': 'Shops > Surplus',
  '19059000': 'Shops > Swimming Pool',
  '19060000': 'Shops > Tobacco',
  '19061000': 'Shops > Toys',
  '19062000': 'Shops > Trophy Shops',
  '19063000': 'Shops > Used',
  '19064000': 'Shops > Vape',
  '19065000': 'Shops > Video & DVD',
  '19066000': 'Shops > Warehouse Stores',
  '19067000': 'Shops > Wholesale',
  '19068000': 'Shops > Wigs',

  // Transfer (21000000)
  '21000000': 'Transfer',
  '21001000': 'Transfer > Billpay',
  '21002000': 'Transfer > Check',
  '21003000': 'Transfer > Credit',
  '21004000': 'Transfer > Debit',
  '21005000': 'Transfer > Deposit',
  '21005001': 'Transfer > ATM Deposit',
  '21005002': 'Transfer > Check Deposit',
  '21005003': 'Transfer > Direct Deposit',
  '21006000': 'Transfer > Keep the Change Savings',
  '21007000': 'Transfer > Payroll',
  '21008000': 'Transfer > Save As You Go',
  '21009000': 'Transfer > Third Party',
  '21009001': 'Transfer > Apple Pay',
  '21009002': 'Transfer > Cash App',
  '21009003': 'Transfer > Chase QuickPay',
  '21009004': 'Transfer > Google Pay',
  '21009005': 'Transfer > PayPal',
  '21009006': 'Transfer > Samsung Pay',
  '21009007': 'Transfer > Venmo',
  '21009008': 'Transfer > Zelle',
  '21009009': 'Transfer > Wise',
  '21010000': 'Transfer > Withdrawal',
  '21010001': 'Transfer > ATM Withdrawal',
  '21010002': 'Transfer > Check Withdrawal',
  '21011000': 'Transfer > Wire',

  // Travel (22000000)
  '22000000': 'Travel',
  '22001000': 'Travel > Airlines',
  '22002000': 'Travel > Airports',
  '22003000': 'Travel > Boat',
  '22004000': 'Travel > Bus',
  '22005000': 'Travel > Cab',
  '22005001': 'Travel > Rideshare',
  '22006000': 'Travel > Car Rental',
  '22007000': 'Travel > Car Service',
  '22008000': 'Travel > Charter Buses',
  '22009000': 'Travel > Cruises',
  '22010000': 'Travel > Gas Station',
  '22011000': 'Travel > Heliport',
  '22012000': 'Travel > Hotel',
  '22012001': 'Travel > Bed & Breakfast',
  '22012002': 'Travel > Hostel',
  '22012003': 'Travel > Hotel & Motel',
  '22012004': 'Travel > Resort',
  '22012005': 'Travel > Vacation Rental',
  '22013000': 'Travel > Limo',
  '22014000': 'Travel > Lodging',
  '22015000': 'Travel > Metro',
  '22016000': 'Travel > Parking',
  '22017000': 'Travel > Rail',
  '22018000': 'Travel > Taxi',
  '22019000': 'Travel > Tolls & Fees',
  '22020000': 'Travel > Tours',
  '22021000': 'Travel > Transportation Center',

  // ============================================
  // COPILOT MONEY SPECIFIC CATEGORIES
  // (Custom categories that Copilot may use)
  // ============================================
  uncategorized: 'Uncategorized',
  Uncategorized: 'Uncategorized',
  other: 'Other',
  unknown: 'Unknown',

  // Common custom categories
  subscriptions: 'Subscriptions',
  subscription: 'Subscriptions',
  streaming: 'Streaming Services',
  software: 'Software',
  membership: 'Memberships',
  fees: 'Fees',
  refund: 'Refund',
  reimbursement: 'Reimbursement',
  gift: 'Gift',
  atm: 'ATM',
  cash: 'Cash',
  paycheck: 'Paycheck',
  salary: 'Salary',
  bonus: 'Bonus',
  investment: 'Investment',
  savings: 'Savings',
  debt_payment: 'Debt Payment',
  credit_card: 'Credit Card Payment',
  mortgage: 'Mortgage',
  auto_loan: 'Auto Loan',
  student_loan: 'Student Loan',
  personal_loan: 'Personal Loan',

  // Investment categories
  buy: 'Investment > Buy',
  sell: 'Investment > Sell',
  dividend: 'Investment > Dividend',
  capital_gain: 'Investment > Capital Gain',
  contribution: 'Investment > Contribution',
  withdrawal: 'Investment > Withdrawal',
};

/**
 * Categories that represent transfers (for exclude_transfers filtering).
 *
 * These category IDs indicate money moving between accounts rather than
 * actual spending/income.
 */
export const TRANSFER_CATEGORIES = new Set([
  // Snake case categories
  'transfer_in',
  'transfer_in_account_transfer',
  'transfer_in_cash_advances_and_loans',
  'transfer_in_deposit',
  'transfer_in_investment_and_retirement_funds',
  'transfer_in_savings',
  'transfer_in_other_transfer_in',
  'transfer_out',
  'transfer_out_account_transfer',
  'transfer_out_investment_and_retirement_funds',
  'transfer_out_savings',
  'transfer_out_withdrawal',
  'transfer_out_other_transfer_out',
  'loan_payments_credit_card_payment',

  // Numeric transfer categories
  '21000000', // Transfer
  '21001000', // Transfer > Billpay
  '21002000', // Transfer > Check
  '21003000', // Transfer > Credit
  '21004000', // Transfer > Debit
  '21005000', // Transfer > Deposit
  '21005001', // Transfer > ATM Deposit
  '21005002', // Transfer > Check Deposit
  '21005003', // Transfer > Direct Deposit
  '21006000', // Transfer > Keep the Change
  '21007000', // Transfer > Payroll
  '21008000', // Transfer > Save As You Go
  '21009000', // Transfer > Third Party
  '21009001', // Transfer > Apple Pay
  '21009002', // Transfer > Cash App
  '21009003', // Transfer > Chase QuickPay
  '21009004', // Transfer > Google Pay
  '21009005', // Transfer > PayPal
  '21009006', // Transfer > Samsung Pay
  '21009007', // Transfer > Venmo
  '21009008', // Transfer > Zelle
  '21009009', // Transfer > Wise
  '21010000', // Transfer > Withdrawal
  '21010001', // Transfer > ATM Withdrawal
  '21010002', // Transfer > Check Withdrawal
  '21011000', // Transfer > Wire
]);

/**
 * Categories that represent income.
 */
export const INCOME_CATEGORIES = new Set([
  // Snake case categories
  'income',
  'income_dividends',
  'income_interest_earned',
  'income_retirement_pension',
  'income_tax_refund',
  'income_unemployment',
  'income_wages',
  'income_other_income',
  'paycheck',
  'salary',
  'bonus',
  'refund',
  'reimbursement',
  'dividend',

  // Numeric categories
  '15000000', // Interest
  '15001000', // Interest > Interest Earned
  '21007000', // Transfer > Payroll
  '21005003', // Transfer > Direct Deposit
]);

/**
 * Get the human-readable name for a category ID.
 *
 * @param categoryId - The category ID (e.g., "13005000", "food_dining", or user-defined IDs)
 * @param userCategoryMap - Optional map of user-defined category IDs to names.
 *                          Pass this to resolve custom Copilot Money categories.
 * @returns Human-readable category name, or the original ID if not found
 */
export function getCategoryName(categoryId: string, userCategoryMap?: Map<string, string>): string {
  // First, check user-defined categories (highest priority)
  // These are custom categories created by the user in Copilot Money
  if (userCategoryMap) {
    const userName = userCategoryMap.get(categoryId);
    if (userName) {
      return userName;
    }
  }

  // Check exact match in static Plaid categories
  if (CATEGORY_NAMES[categoryId]) {
    return CATEGORY_NAMES[categoryId];
  }

  // Try lowercase version
  const lowerId = categoryId.toLowerCase();
  if (CATEGORY_NAMES[lowerId]) {
    return CATEGORY_NAMES[lowerId];
  }

  // For unknown categories, try to make them human-readable
  // Convert snake_case to Title Case
  if (categoryId.includes('_')) {
    return categoryId
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  // Return original if no transformation possible
  return categoryId;
}

/**
 * Check if a category ID represents a transfer.
 *
 * @param categoryId - The category ID to check
 * @returns true if the category is a transfer
 */
export function isTransferCategory(categoryId: string | undefined): boolean {
  if (!categoryId) return false;

  // Check exact match
  if (TRANSFER_CATEGORIES.has(categoryId)) return true;

  // Check lowercase
  if (TRANSFER_CATEGORIES.has(categoryId.toLowerCase())) return true;

  // Check if category name contains transfer keywords
  const lowerCategory = categoryId.toLowerCase();
  return (
    lowerCategory.includes('transfer') ||
    lowerCategory.includes('payment') ||
    lowerCategory === 'credit_card'
  );
}

/**
 * Check if a category ID represents income.
 *
 * @param categoryId - The category ID to check
 * @returns true if the category is income-related
 */
export function isIncomeCategory(categoryId: string | undefined): boolean {
  if (!categoryId) return false;

  // Check exact match
  if (INCOME_CATEGORIES.has(categoryId)) return true;

  // Check lowercase
  if (INCOME_CATEGORIES.has(categoryId.toLowerCase())) return true;

  // Check if category name contains income keywords
  const lowerCategory = categoryId.toLowerCase();
  return (
    lowerCategory.includes('income') ||
    lowerCategory.includes('payroll') ||
    lowerCategory.includes('salary') ||
    lowerCategory.includes('wage')
  );
}

/**
 * Check if a category ID is a known Plaid category.
 *
 * This is useful for filtering out orphaned references to deleted user categories.
 * If a category_id doesn't resolve to either a user category or a known Plaid category,
 * it's likely a deleted/orphaned category reference.
 *
 * @param categoryId - The category ID to check
 * @returns true if the category is a known Plaid category
 */
export function isKnownPlaidCategory(categoryId: string): boolean {
  // Check exact match
  if (categoryId in CATEGORY_NAMES) return true;

  // Check lowercase version
  return categoryId.toLowerCase() in CATEGORY_NAMES;
}
